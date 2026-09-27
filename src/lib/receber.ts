import "server-only";
import { all, insert, nextNumber, nextNumbers, one, run, scalar } from "./db";
import { montarParcelas, situacaoParcela } from "./financeiro";
import { validarDataPrevista, validarValorAdiantamento } from "./adiantamento";
import { money, today } from "./format";

/**
 * Contas a receber.
 *
 * Uma locacao de R$2.000 em 4x nao e R$2.000 em caixa: sao quatro previsoes.
 * Cada parcela vira uma linha em financial_entries; o dinheiro so aparece
 * quando um pagamento e registrado em payments, que continua sendo o unico
 * livro de entradas do sistema.
 *
 * Nada aqui altera reservas ou fretes: o modulo apenas le o total deles e
 * cria as previsoes correspondentes.
 */

export type OrigemRecebivel =
  | { tipo: "locacao"; reservationId: number }
  | { tipo: "frete"; freightId: number };

/** Quanto ja foi recebido de uma parcela, somado dos pagamentos ligados a ela. */
export async function recebidoDaParcela(entryId: number): Promise<number> {
  return await scalar<number>(`SELECT COALESCE(SUM(amount_cents),0) FROM payments WHERE entry_id = ?`, [entryId]);
}

/**
 * Cria (ou refaz) as parcelas a receber de uma reserva ou frete.
 *
 * Recusa refazer quando alguma parcela ja tem recebimento, pelo mesmo motivo
 * das compras: reconstruir apagaria dinheiro registrado.
 */
export async function gerarRecebiveis(
  origem: OrigemRecebivel,
  opts: { parcelas: number; primeiroVencimento: string; accountId?: number | null; userId?: number },
): Promise<string | null> {
  const ehLocacao = origem.tipo === "locacao";
  const idOrigem = ehLocacao ? origem.reservationId : origem.freightId;
  const coluna = ehLocacao ? "reservation_id" : "freight_id";

  const doc = ehLocacao
    ? await one<any>(
        `SELECT r.id, r.number, r.total_cents, r.customer_id, c.name AS customer_name
           FROM reservations r JOIN customers c ON c.id = r.customer_id WHERE r.id = ?`,
        [idOrigem],
      )
    : await one<any>(
        `SELECT f.id, f.number, f.amount_cents AS total_cents, f.customer_id, c.name AS customer_name
           FROM freights f LEFT JOIN customers c ON c.id = f.customer_id WHERE f.id = ?`,
        [idOrigem],
      );
  if (!doc) return "Registro não encontrado.";

  const recebido = await scalar<number>(
    `SELECT COALESCE(SUM(p.amount_cents),0) FROM payments p
       JOIN financial_entries e ON e.id = p.entry_id
      WHERE e.${coluna} = ?`,
    [idOrigem],
  );
  if (recebido > 0) {
    return "Já existe recebimento lançado nestas parcelas. Estorne antes de refazer o parcelamento.";
  }

  // sinal ou entrada lancados antes do parcelamento ja sao dinheiro em caixa;
  // parcelar o total cheio faria a previsao contar esse dinheiro de novo
  const jaRecebido = await scalar<number>(
    `SELECT COALESCE(SUM(amount_cents),0) FROM payments WHERE ${coluna} = ? AND entry_id IS NULL`,
    [idOrigem],
  );
  // um adiantamento agendado (ainda nao confirmado) tambem ja e uma promessa
  // sobre este dinheiro: parcelar o total cheio por cima duplicaria a previsao
  const jaAgendadoAdiantamento = ehLocacao
    ? await scalar<number>(
        `SELECT COALESCE(SUM(amount_cents),0) FROM financial_entries
          WHERE reservation_id = ? AND category = 'Adiantamento' AND status = 'aberta'`,
        [idOrigem],
      )
    : 0;
  const aParcelar = doc.total_cents - jaRecebido - jaAgendadoAdiantamento;

  // o adiantamento tem sua propria secao, com suas proprias acoes de
  // confirmar/editar/cancelar e a trava contra dupla confirmacao; refazer o
  // parcelamento nunca pode apaga-lo por baixo dos panos
  await run(
    `DELETE FROM financial_entries WHERE ${coluna} = ? AND direction = 'receber'
       AND (category IS NULL OR category <> 'Adiantamento')`,
    [idOrigem],
  );
  if (doc.total_cents <= 0) return null;
  if (aParcelar <= 0) {
    return jaAgendadoAdiantamento > 0
      ? `Nada a parcelar: ${money(jaRecebido)} já recebidos e ${money(jaAgendadoAdiantamento)} agendados de adiantamento cobrem o total de ${money(doc.total_cents)}.`
      : `Nada a parcelar: ${money(jaRecebido)} já recebidos cobrem o total de ${money(doc.total_cents)}.`;
  }

  const parcelas = montarParcelas(aParcelar, opts.parcelas, opts.primeiroVencimento);
  // numeros gerados de uma vez (uma leitura), em vez de um SELECT por parcela
  const numeros = await nextNumbers("financial_entries", "REC", parcelas.length);
  let i = 0;
  for (const p of parcelas) {
    const numero = numeros[i++];
    await insert(
      `INSERT INTO financial_entries
        (number, direction, origin, customer_id, ${coluna}, category, description,
         amount_cents, due_date, installment, installments_total, account_id, created_by)
       VALUES (?,'receber',?,?,?,?,?,?,?,?,?,?,?)`,
      [
        numero,
        ehLocacao ? "locacao" : "frete",
        doc.customer_id,
        idOrigem,
        ehLocacao ? "Locacao" : "Frete",
        `${doc.number}${parcelas.length > 1 ? ` ${p.installment}/${p.installments_total}` : ""}` +
          (doc.customer_name ? ` - ${doc.customer_name}` : ""),
        p.amount_cents,
        p.due_date,
        p.installment,
        p.installments_total,
        opts.accountId ?? null,
        opts.userId ?? null,
      ],
    );
  }
  return null;
}

const ENTRY_SELECT = `
  SELECT e.*,
         COALESCE((SELECT SUM(p.amount_cents) FROM payments p WHERE p.entry_id = e.id),0) AS recebido_cents,
         COALESCE((SELECT SUM(x.amount_cents) FROM expenses x WHERE x.entry_id = e.id),0) AS pago_cents,
         c.name AS customer_name, s.name AS supplier_name,
         r.number AS reservation_number, f.number AS freight_number, pu.number AS purchase_number
    FROM financial_entries e
    LEFT JOIN customers c ON c.id = e.customer_id
    LEFT JOIN suppliers s ON s.id = e.supplier_id
    LEFT JOIN reservations r ON r.id = e.reservation_id
    LEFT JOIN freights f ON f.id = e.freight_id
    LEFT JOIN purchases pu ON pu.id = e.purchase_id`;

/** Parcelas de uma reserva ou frete. */
/**
 * Parcelas do parcelamento comum de uma reserva ou frete.
 *
 * Exclui o adiantamento de proposito: ele tem sua propria secao e suas
 * proprias acoes de confirmar/editar/cancelar, com a trava contra dupla
 * confirmacao. Se aparecesse aqui tambem, o mesmo lancamento teria dois
 * botoes de "receber" em dois formularios diferentes — e o formulario de
 * parcela comum nao tem essa trava, porque nunca precisou dela.
 */
export async function recebiveisDe(origem: OrigemRecebivel) {
  const coluna = origem.tipo === "locacao" ? "reservation_id" : "freight_id";
  const id = origem.tipo === "locacao" ? origem.reservationId : origem.freightId;
  return await all<any>(
    `${ENTRY_SELECT} WHERE e.${coluna} = ? AND e.direction = 'receber'
       AND (e.category IS NULL OR e.category <> 'Adiantamento')
     ORDER BY e.installment`,
    [id],
  );
}

export type FiltroEntries = {
  direction: "receber" | "pagar";
  situacao?: "todas" | "abertas" | "vencidas" | "quitadas";
  de?: string;
  ate?: string;
  busca?: string;
  limite?: number;
};

/** Lista de parcelas com a situacao ja resolvida, para as telas de consulta. */
export async function listarEntries(f: FiltroEntries) {
  const where: string[] = ["e.direction = ?"];
  const params: any[] = [f.direction];

  if (f.de && f.ate) {
    where.push("e.due_date BETWEEN ? AND ?");
    params.push(f.de, f.ate);
  }
  if (f.busca) {
    where.push("(e.number LIKE ? OR e.description LIKE ? OR c.name LIKE ? OR s.name LIKE ?)");
    const like = `%${f.busca}%`;
    params.push(like, like, like, like);
  }

  const rows = await all<any>(
    `${ENTRY_SELECT} WHERE ${where.join(" AND ")} ORDER BY e.due_date, e.id LIMIT ?`,
    [...params, f.limite ?? 300],
  );

  const d0 = today();
  const comSituacao = rows.map((e) => {
    const liquidado = f.direction === "receber" ? e.recebido_cents : e.pago_cents;
    return {
      ...e,
      liquidado_cents: liquidado,
      saldo_cents: Math.max(0, e.amount_cents - liquidado),
      situacao: situacaoParcela(e, liquidado, d0),
    };
  });

  if (!f.situacao || f.situacao === "todas") return comSituacao;
  if (f.situacao === "abertas") return comSituacao.filter((e) => e.situacao === "aberta" || e.situacao === "parcial");
  if (f.situacao === "vencidas") return comSituacao.filter((e) => e.situacao === "vencida");
  return comSituacao.filter((e) => e.situacao === "quitada");
}

/** Totais de previsto, liquidado e em atraso, para os cartoes do painel. */
export async function totaisEntries(direction: "receber" | "pagar") {
  const campo = direction === "receber" ? "payments" : "expenses";
  const linha = await one<any>(
    `SELECT
       COALESCE(SUM(e.amount_cents),0) AS previsto,
       COALESCE(SUM((SELECT SUM(m.amount_cents) FROM ${campo} m WHERE m.entry_id = e.id)),0) AS liquidado,
       COALESCE(SUM(CASE WHEN e.due_date < ? THEN e.amount_cents END),0) AS vencendo
     FROM financial_entries e
     WHERE e.direction = ? AND e.status <> 'cancelada'`,
    [today(), direction],
  );

  // atrasado e o que ja venceu e ainda nao foi liquidado
  const vencidas = await all<any>(
    `SELECT e.amount_cents,
            COALESCE((SELECT SUM(m.amount_cents) FROM ${campo} m WHERE m.entry_id = e.id),0) AS liquidado
       FROM financial_entries e
      WHERE e.direction = ? AND e.status <> 'cancelada' AND e.due_date < ?`,
    [direction, today()],
  );
  const atrasado = vencidas.reduce((s, e) => s + Math.max(0, e.amount_cents - e.liquidado), 0);

  const previsto = Number(linha?.previsto ?? 0);
  const liquidado = Number(linha?.liquidado ?? 0);
  return { previsto, liquidado, saldo: Math.max(0, previsto - liquidado), atrasado };
}

/* ------------------------------------------------------------------ */
/* Adiantamento                                                        */
/* ------------------------------------------------------------------ */

/**
 * Adiantamento de uma reserva.
 *
 * Nao e um livro novo: cenario A (pago agora) grava direto em `payments`,
 * igual a qualquer pagamento de reserva; cenario B (agendado) cria uma linha
 * em `financial_entries` marcada com category='Adiantamento', igual a
 * qualquer parcela a receber. A diferenca do parcelamento comum e que aqui o
 * valor e livre (nao precisa somar o total da reserva) e so existe um
 * adiantamento em aberto por vez, para a tela ter um lugar so para mostrar.
 */

/** Quanto ainda pode ser prometido: total menos recebido menos ja agendado. */
export async function saldoDisponivelAdiantamento(reservationId: number): Promise<number> {
  const r = await one<any>(`SELECT total_cents FROM reservations WHERE id = ?`, [reservationId]);
  if (!r) return 0;
  const recebido = await scalar<number>(`SELECT COALESCE(SUM(amount_cents),0) FROM payments WHERE reservation_id = ?`, [
    reservationId,
  ]);
  const agendado = await scalar<number>(
    `SELECT COALESCE(SUM(amount_cents),0) FROM financial_entries
      WHERE reservation_id = ? AND category = 'Adiantamento' AND status = 'aberta'`,
    [reservationId],
  );
  return Math.max(0, r.total_cents - recebido - agendado);
}

/** O adiantamento em aberto da reserva, se existir. So um por vez. */
export async function adiantamentoAberto(reservationId: number) {
  return await one<any>(
    `SELECT * FROM financial_entries WHERE reservation_id = ? AND category = 'Adiantamento' AND status = 'aberta'
      ORDER BY id DESC LIMIT 1`,
    [reservationId],
  );
}

/** Historico completo de adiantamentos da reserva, do mais recente ao mais antigo. */
export async function adiantamentosDaReserva(reservationId: number) {
  return await all<any>(
    `${ENTRY_SELECT} WHERE e.reservation_id = ? AND e.category = 'Adiantamento' ORDER BY e.id DESC`,
    [reservationId],
  );
}

type EntradaAdiantamento = {
  reservationId: number;
  amountCents: number;
  imediato: boolean;
  dataPrevista: string;
  method: string;
  accountId?: number | null;
  notes?: string;
  userId: number;
};

/**
 * Registra o adiantamento, nos dois cenarios.
 *
 * Cenario A: entra direto em payments, contado na hora. Cenario B: vira uma
 * previsao em financial_entries, e o dinheiro so aparece quando alguem
 * confirmar o recebimento — exatamente a mesma regra que ja vale para
 * qualquer parcela a receber deste sistema.
 */
export async function criarAdiantamento(opts: EntradaAdiantamento): Promise<string | null> {
  const reserva = await one<any>(
    `SELECT r.id, r.number, r.customer_id, c.name AS customer_name FROM reservations r
       JOIN customers c ON c.id = r.customer_id WHERE r.id = ?`,
    [opts.reservationId],
  );
  if (!reserva) return "Reserva não encontrada.";

  const saldo = await saldoDisponivelAdiantamento(opts.reservationId);
  const erroValor = validarValorAdiantamento(opts.amountCents, saldo);
  if (erroValor) return erroValor;

  if (opts.imediato) {
    // a conta acompanha o dinheiro: o adiantamento recebido aqui ja e caixa,
    // entao o account_id tem que sobreviver ate o payments, igual acontece na
    // confirmacao de um adiantamento agendado (confirmarAdiantamento)
    await insert(
      `INSERT INTO payments (reservation_id, amount_cents, method, paid_at, notes, account_id, created_by)
       VALUES (?,?,?,?,?,?,?)`,
      [
        opts.reservationId,
        opts.amountCents,
        opts.method,
        opts.dataPrevista || today(),
        "Adiantamento",
        opts.accountId ?? null,
        opts.userId,
      ],
    );
    return null;
  }

  const erroData = validarDataPrevista(opts.dataPrevista);
  if (erroData) return erroData;

  // so um adiantamento agendado por vez: a tela mostra um lugar so, e permitir
  // dois ao mesmo tempo so criaria confusao sobre qual confirmar
  const existente = await adiantamentoAberto(opts.reservationId);
  if (existente) {
    return "Já existe um adiantamento agendado para esta reserva. Confirme ou cancele o atual antes de criar outro.";
  }

  const numero = await nextNumber("financial_entries", "REC");
  await insert(
    `INSERT INTO financial_entries
      (number, direction, origin, customer_id, reservation_id, category, description,
       amount_cents, due_date, installment, installments_total, account_id, expected_method, notes, created_by)
     VALUES (?,'receber','locacao',?,?,'Adiantamento',?,?,?,1,1,?,?,?,?)`,
    [
      numero,
      reserva.customer_id,
      opts.reservationId,
      `Adiantamento ${reserva.number} - ${reserva.customer_name}`,
      opts.amountCents,
      opts.dataPrevista,
      opts.accountId ?? null,
      opts.method,
      opts.notes ?? null,
      opts.userId,
    ],
  );
  return null;
}

/** Altera valor, data ou forma prevista de um adiantamento ainda em aberto. */
export async function atualizarAdiantamentoAgendado(
  entryId: number,
  opts: { amountCents: number; dataPrevista: string; method: string; userId: number },
): Promise<string | null> {
  const entry = await one<any>(
    `SELECT * FROM financial_entries WHERE id = ? AND category = 'Adiantamento'`,
    [entryId],
  );
  if (!entry) return "Adiantamento não encontrado.";
  if (entry.status !== "aberta") return "Este adiantamento já foi recebido ou cancelado e não pode ser alterado.";

  // o saldo disponivel ignora este proprio adiantamento, senao ele contaria
  // duas vezes contra si mesmo na hora de validar o novo valor
  const saldo = (await saldoDisponivelAdiantamento(entry.reservation_id)) + entry.amount_cents;
  const erroValor = validarValorAdiantamento(opts.amountCents, saldo);
  if (erroValor) return erroValor;
  const erroData = validarDataPrevista(opts.dataPrevista);
  if (erroData) return erroData;

  const r = await run(
    `UPDATE financial_entries SET amount_cents=?, due_date=?, expected_method=?, updated_at=datetime('now','localtime')
      WHERE id=? AND status='aberta'`,
    [opts.amountCents, opts.dataPrevista, opts.method, entryId],
  );
  if (!r.meta.changes) return "Este adiantamento já foi recebido ou cancelado e não pode ser alterado.";
  return null;
}

/** Cancela um agendamento que ainda nao foi recebido. Preserva o registro. */
export async function cancelarAdiantamentoAgendado(entryId: number): Promise<boolean> {
  const r = await run(
    `UPDATE financial_entries SET status='cancelada', updated_at=datetime('now','localtime')
      WHERE id=? AND category='Adiantamento' AND status='aberta'`,
    [entryId],
  );
  return !!r.meta.changes;
}

/**
 * Confirma o recebimento de um adiantamento agendado.
 *
 * A trava e o UPDATE em si: ele so muda alguma linha se o lancamento ainda
 * estiver aberto no instante exato em que roda, e o D1 executa cada
 * declaracao de forma atomica mesmo fora de uma transacao explicita. Duas
 * confirmacoes simultaneas viram duas UPDATEs concorrentes; so uma acha a
 * linha em 'aberta' e muda alguma coisa, a outra ve mudanca zero e para ali,
 * antes de cogitar inserir um pagamento. O mesmo padrao usado em
 * usarRecompensa (fidelidade) e em assinar (contrato).
 */
export async function confirmarAdiantamento(
  entryId: number,
  opts: { method?: string; paidAt: string; accountId?: number | null; userId: number },
): Promise<string | null> {
  const entry = await one<any>(
    `SELECT * FROM financial_entries WHERE id = ? AND category = 'Adiantamento'`,
    [entryId],
  );
  if (!entry) return "Adiantamento não encontrado.";
  if (entry.status === "cancelada") return "Este adiantamento foi cancelado e não pode ser confirmado.";

  const marcou = await run(
    `UPDATE financial_entries SET status='quitada', updated_at=datetime('now','localtime') WHERE id=? AND status='aberta'`,
    [entryId],
  );
  if (!marcou.meta.changes) return "Este adiantamento já foi confirmado.";

  const metodo = opts.method || entry.expected_method || "pix";
  await insert(
    `INSERT INTO payments (reservation_id, amount_cents, method, paid_at, notes, entry_id, account_id, created_by)
     VALUES (?,?,?,?,?,?,?,?)`,
    [
      entry.reservation_id,
      entry.amount_cents,
      metodo,
      opts.paidAt || today(),
      entry.description,
      entryId,
      opts.accountId ?? entry.account_id,
      opts.userId,
    ],
  );
  return null;
}

/** Adiantamentos agendados que vencem hoje ou ja venceram, para o painel e a rotina diaria. */
export async function adiantamentosPendentes(hoje = today()) {
  return await all<any>(
    `SELECT e.*, c.name AS customer_name, r.number AS reservation_number
       FROM financial_entries e
       JOIN customers c ON c.id = e.customer_id
       LEFT JOIN reservations r ON r.id = e.reservation_id
      WHERE e.category = 'Adiantamento' AND e.status = 'aberta' AND e.due_date <= ?
      ORDER BY e.due_date, e.id`,
    [hoje],
  );
}
