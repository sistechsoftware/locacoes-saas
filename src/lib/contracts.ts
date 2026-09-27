import "server-only";
import { insert, nextNumber, one } from "./db";
import { getSettings, renderTemplate, renderTemplateHtml, type Settings } from "./settings";
import { getCompanySignature } from "./assinatura-empresa";
import { contractUsesHtml, itensParaHtml, marcaConfiavel } from "./contract-html";
import { getReservation, reservationItems, reservationMoney } from "./reservations";
import { dateBR, dataPorExtensoBR, docBR, money, phoneBR, today } from "./format";

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
        ...variaveisComuns(s, r, m, contractNumber),
        itens: itensTexto,
      },
      // campo sem cadastro vira linha para preencher a mao no documento impresso
      { vazio: "linha" },
    );
  }

  const vars = {
    ...variaveisComuns(s, r, m, contractNumber),
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
): Promise<string> {
  const s = await getSettings();
  const r = await getReservation(reservationId);
  if (!r) throw new Error("Reserva não encontrada");
  const items = await reservationItems(reservationId);
  const m = await reservationMoney(reservationId);

  if (!contractUsesHtml(s.contract_template_digital)) {
    const itensTexto = items
      .map((i) => `- ${i.qty} x ${i.product_name} .......... ${money(i.subtotal_cents)}`)
      .join("\n");

    return renderTemplate(
      s.contract_template_digital,
      {
        ...variaveisComuns(s, r, m, contractNumber),
        // disponivel so no modelo digital: cidade + data de abertura por extenso
        data_assinatura_digital: variavelDataAssinaturaDigital(),
        itens: itensTexto,
      },
      { vazio: "linha" },
    );
  }

  const vars = {
    ...variaveisComuns(s, r, m, contractNumber),
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

/** Variaveis do contrato que nao dependem do formato do modelo. */
function variaveisComuns(
  s: Settings,
  r: any,
  m: { deposit: number },
  contractNumber: string,
): Record<string, string | number | null | undefined> {
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
      data_hoje: new Date().toLocaleDateString("pt-BR"),
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
  const number = await nextNumber("contracts", "CTR");
  const body = await buildContractBody(reservationId, number);
  const temAssinaturaEmpresa = (await getCompanySignature()) !== null;
  return await insert(
    `INSERT INTO contracts (number, reservation_id, status, body, created_by, company_signature_included) VALUES (?,?,'pendente',?,?,?)`,
    [number, reservationId, body, userId ?? null, temAssinaturaEmpresa ? 1 : 0],
  );
}
