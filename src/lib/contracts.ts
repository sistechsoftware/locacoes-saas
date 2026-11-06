import "server-only";
import { batch, insert, nextNumber, one, run } from "./db";
import { getSettings, renderTemplate, renderTemplateHtml, settingsDaEmpresa, type Settings } from "./settings";
import { getCompanySignature } from "./assinatura-empresa";
import { contractUsesHtml, itensParaHtml, marcaConfiavel } from "./contract-html";
import { getReservation, reservationItems, reservationMoney } from "./reservations";
import { adiantamentoPrevisto, percentualAdiantamento, saldoContratualPrevisto } from "./receber";
import { exprDePct } from "./desconto";
import { dateBR, dataPorExtensoBR, docBR, money, nowLocal, phoneBR, today } from "./format";

/** Monta o texto do contrato a partir do modelo configurado e dos dados da reserva. */
export async function buildContractBody(reservationId: number, contractNumber: string): Promise<string> {
  const s = await getSettings();
  const r = await getReservation(reservationId);
  if (!r) throw new Error("Reserva não encontrada");
  const items = await reservationItems(reservationId);
  const m = await reservationMoney(reservationId);

  /**
   * Modelo antigo em texto puro segue o caminho de sempre, byte a byte. Modelo
   * formatado (HTML) recebe as mesmas variaveis, mas com {{itens}} em lista
   * HTML e as demais variaveis escapadas (veja renderTemplateHtml).
   */
  if (!contractUsesHtml(s.contract_template)) {
    const itensTexto = items
      .map((i) => `- ${i.qty} x ${i.product_name} .......... ${money(i.subtotal_cents)}`)
      .join("\n");

    return renderTemplate(
      s.contract_template,
      {
        ...(await variaveisComuns(s, r, m, contractNumber)),
        itens: itensTexto,
      },
      // campo sem cadastro vira linha para preencher a mao no documento impresso
      { vazio: "linha" },
    );
  }

  const vars = {
    ...(await variaveisComuns(s, r, m, contractNumber)),
    itens: marcaConfiavel(
      itensParaHtml(
        items.map((i) => `${i.qty} x ${i.product_name} .......... ${money(i.subtotal_cents)}`),
      ),
    ),
  };

  return renderTemplateHtml(s.contract_template, vars, { vazio: "linha" });
}

/**
 * Monta o corpo do contrato DIGITAL, a partir do modelo digital.
 *
 * E este corpo que o cliente le e assina no link publico: o mesmo texto que
 * sai daqui e congelado em body_snapshot no momento da assinatura. O modelo de
 * impressao nao participa deste caminho — e essa separacao que garante que
 * editar um modelo nao mexe no outro.
 */
export async function buildContractBodyDigital(
  reservationId: number,
  contractNumber: string,
  /**
   * Empresa dona do contrato, quando o chamador ja a conhece.
   *
   * O caminho PUBLICO (/assinar/[token]) abre sem sessao, entao o fallback de
   * tenant resolvia a empresa PADRAO do banco e a leitura da reserva valhava
   * para a empresa errada — "Reserva não encontrada" e o link do cliente
   * quebrando na primeira abertura. A pagina publica le o company_id do
   * registro pelo token e passa ele aqui; os fluxos autenticados continuam sem
   * argumento e usam a sessao, exatamente como antes.
   */
  companyId?: number,
): Promise<string> {
  const s = companyId !== undefined ? await settingsDaEmpresa(companyId) : await getSettings();
  const r = await getReservation(reservationId, companyId);
  if (!r) throw new Error("Reserva não encontrada");
  const items = await reservationItems(reservationId, companyId);
  const m = await reservationMoney(reservationId, companyId);

  if (!contractUsesHtml(s.contract_template_digital)) {
    const itensTexto = items
      .map((i) => `- ${i.qty} x ${i.product_name} .......... ${money(i.subtotal_cents)}`)
      .join("\n");

    return renderTemplate(
      s.contract_template_digital,
      {
        ...(await variaveisComuns(s, r, m, contractNumber, companyId)),
        // disponivel so no modelo digital: cidade + data de abertura por extenso
        data_assinatura_digital: variavelDataAssinaturaDigital(),
        itens: itensTexto,
      },
      { vazio: "linha" },
    );
  }

  const vars = {
    ...(await variaveisComuns(s, r, m, contractNumber, companyId)),
    // disponivel so no modelo digital: cidade + data de abertura por extenso
    data_assinatura_digital: variavelDataAssinaturaDigital(),
    itens: marcaConfiavel(
      itensParaHtml(
        items.map((i) => `${i.qty} x ${i.product_name} .......... ${money(i.subtotal_cents)}`),
      ),
    ),
  };

  return renderTemplateHtml(s.contract_template_digital, vars, { vazio: "linha" });
}

/**
 * Variaveis do contrato que nao dependem do formato do modelo.
 *
 * E o UNICO ponto em que os dois formatos (impressao e digital) montam suas
 * variaveis: qualquer valor novo entra aqui para valer nos dois, sem lógica
 * duplicada. `companyId` acompanha o da propria reserva (a pagina publica de
 * assinatura passa o do token) para a leitura financeira ficar no mesmo escopo
 * de tenant da reserva; sem ele vale a sessao, como em getReservation.
 */
async function variaveisComuns(
  s: Settings,
  r: any,
  m: { deposit: number },
  contractNumber: string,
  companyId?: number,
): Promise<Record<string, string | number | null | undefined>> {
  /* Condicoes comerciais da contratacao, nunca o caixa: o adiantamento previsto
   * nao muda porque o cliente pagou (ou nao) — e dele que sai o saldo
   * contratual previsto. O total contratado e o proprio total da reserva. */
  const adiantamento = await adiantamentoPrevisto(r.id, companyId);
  const saldoContratual = saldoContratualPrevisto(r.total_cents, adiantamento);
  const pctAdiantamento = await percentualAdiantamento(companyId);

  return {
      empresa: s.company_name,
      cnpj: docBR(s.company_doc),
      endereco_empresa: s.company_address,
      telefone_empresa: phoneBR(s.company_phone),
      cidade_empresa: s.company_city,
      cliente: r.customer_name,
      cliente_doc: docBR(r.customer_doc),
      cliente_telefone: phoneBR(r.customer_phone),
      cliente_email: r.customer_email,
      cliente_bairro: r.customer_district,
      cliente_cidade: r.customer_city,
      cliente_endereco: [r.address, r.district, r.city].filter(Boolean).join(", "),
      contrato: contractNumber,
      reserva: r.number,
      data_evento: dateBR(r.event_date),
      endereco_evento: [r.address, r.district, r.city].filter(Boolean).join(", "),
      data_entrega: r.delivery_at ? `${dateBR(r.delivery_at)} ${r.delivery_at.slice(11, 16)}` : "",
      data_retirada: r.pickup_at ? `${dateBR(r.pickup_at)} ${r.pickup_at.slice(11, 16)}` : "",
      valor_itens: money(r.items_cents),
      valor_frete: money(r.freight_cents),
      valor_montagem: money(r.assembly_cents),
      valor_desmontagem: money(r.disassembly_cents),
      valor_outros: money(r.other_cents),
      valor_desconto: money(r.discount_cents),
      valor_total: money(r.total_cents),
      valor_caucao: money(m.deposit),
      // adiantamento previsto pelas condicoes da reserva (ou pelo percentual
      // padrao da empresa) e saldo contratual previsto (total - adiantamento),
      // independentes dos pagamentos feitos
      adiantamento_valor: money(adiantamento),
      // percentual contratual da empresa ("30%"), para a clausula do contrato
      // nao precisar fixar o numero no texto; sem percentual configurado sai
      // vazio — e a estrategia "linha" nao desenha sublinhado em variavel
      // calculada (fora do LARGURA_LINHA), entao ela nao aparece
      adiantamento_percentual: pctAdiantamento > 0 ? (exprDePct(pctAdiantamento) ?? "") : "",
      valor_saldo: money(saldoContratual),
      data_hoje: dateBR(today()),
  };
}

/**
 * Data de abertura do contrato digital, no formato de cidade e data por
 * extenso: "Uberlândia, 12 de setembro de 2026".
 *
 * Cidade fixa (Uberlândia), data do dia em que o cliente abriu o link para
 * assinar — calculada no fuso do negocio (America/Sao_Paulo, mesma estrategia
 * de today()). Nao e a data da reserva nem a data da assinatura.
 */
function variavelDataAssinaturaDigital(): string {
  return `Uberlândia, ${dataPorExtensoBR(today())}`;
}

/**
 * Cria o contrato da reserva (ou devolve o existente).
 *
 * company_signature_included registra se a assinatura da empresa ja estava
 * cadastrada no momento da geracao: so contratos criados a partir de agora
 * recebem o bloco dela na impressao. Contratos anteriores ficam com NULL e
 * continuam saindo exatamente como sempre sairam.
 */
export async function ensureContract(reservationId: number, userId?: number): Promise<number> {
  const existing = await one<any>(
    `SELECT id FROM contracts WHERE reservation_id = ? AND status <> 'cancelado' ORDER BY id DESC LIMIT 1`,
    [reservationId],
  );
  if (existing) return existing.id;
  return await criarContrato(reservationId, userId);
}

/**
 * Cria SEMPRE um contrato novo da reserva, com numeracao nova e corpo montado
 * a partir dos dados ATUAIS (empresa em company_settings, itens e valores da
 * reserva).
 *
 * E o caminho da substituicao: `ensureContract` reaproveita o contrato vigente
 * (que e justamente o que se quer aposentar), entao a substituicao precisa de
 * uma criacao que nunca devolva um contrato existente.
 *
 * Empresa do contrato = empresa da reserva (a action ja validou a posse).
 */
async function criarContrato(reservationId: number, userId?: number): Promise<number> {
  const dono = await one<{ company_id: number }>(`SELECT company_id FROM reservations WHERE id = ?`, [reservationId]);
  const number = await nextNumber("contracts", "CTR");
  const body = await buildContractBody(reservationId, number);
  const temAssinaturaEmpresa = (await getCompanySignature()) !== null;
  return await insert(
    `INSERT INTO contracts (number, reservation_id, status, body, created_by, company_signature_included, company_id) VALUES (?,?,'pendente',?,?,?,?)`,
    [number, reservationId, body, userId ?? null, temAssinaturaEmpresa ? 1 : 0, dono?.company_id ?? 1],
  );
}

export type ResultadoSubstituicao =
  | { ok: true; novoId: number; numero: string; anterior: string }
  | { ok: false; erro: string };

/**
 * Revoga o contrato atual e emite um novo com os dados cadastrais de agora.
 *
 * NADA e apagado. O contrato anterior recebe status 'cancelado' + revoked_at,
 * revoked_reason e revoked_by, tem os links de assinatura pendentes revogados
 * e aponta para o substituto em superseded_by_id; o novo guarda replaces_id.
 * O snapshot assinado (body_snapshot, document_hash, IP, PNG) fica intacto, e
 * a reserva, itens, valores, pagamentos, adiantamentos e caucao nao sao
 * tocados: a unica escrita acontece em contracts e contract_signatures.
 *
 * O lote final e atomico. Se ele falhar, o contrato recem-criado (ainda sem
 * link e sem assinatura) e descartado para nao existirem dois vigentes.
 */
export async function substituirContrato(
  contractId: number,
  companyId: number,
  usuario: { id: number },
  motivo: string,
): Promise<ResultadoSubstituicao> {
  const atual = await one<any>(
    `SELECT id, number, reservation_id, status, superseded_by_id FROM contracts WHERE id = ? AND company_id = ?`,
    [contractId, companyId],
  );
  if (!atual) return { ok: false, erro: "Contrato não encontrado." };
  if (atual.superseded_by_id) return { ok: false, erro: `O contrato ${atual.number} já foi substituído.` };
  if (atual.status === "cancelado") return { ok: false, erro: `O contrato ${atual.number} está cancelado.` };

  const razao = String(motivo ?? "").trim().slice(0, 300);
  if (razao.length < 3) return { ok: false, erro: "Informe o motivo da substituição." };

  // Primeiro o novo documento, com os dados atuais. Se falhar aqui, nada muda.
  const novoId = await criarContrato(atual.reservation_id, usuario.id);
  const novo = await one<{ number: string }>(`SELECT number FROM contracts WHERE id = ?`, [novoId]);
  if (!novo) return { ok: false, erro: "Não foi possível gerar o novo contrato." };

  const agora = nowLocal();
  try {
    await batch([
      {
        // nenhum link antigo pode continuar valido depois da substituicao
        sql: `UPDATE contract_signatures SET status='revogado', revoked_at=? WHERE contract_id=? AND status='pendente'`,
        params: [agora, contractId],
      },
      {
        sql: `UPDATE contracts
                 SET status='cancelado', revoked_at=?, revoked_reason=?, revoked_by=?, superseded_by_id=?
               WHERE id=? AND company_id=? AND status <> 'cancelado'`,
        params: [agora, razao, usuario.id, novoId, contractId, companyId],
      },
      {
        sql: `UPDATE contracts SET replaces_id=? WHERE id=? AND company_id=?`,
        params: [contractId, novoId, companyId],
      },
    ]);
  } catch {
    await run(`DELETE FROM contracts WHERE id = ? AND company_id = ?`, [novoId, companyId]);
    return { ok: false, erro: "Não foi possível concluir a substituição. Tente novamente." };
  }

  return { ok: true, novoId, numero: novo.number, anterior: atual.number };
}
