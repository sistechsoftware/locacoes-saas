import "server-only";
import { batch, isUniqueViolation, one } from "./db";
import { today } from "./format";

/**
 * Exclusão e estorno de pagamentos / adiantamentos.
 *
 * Duas operações DIFERENTES, nunca equivalentes:
 *
 *  - EXCLUIR: o lançamento foi registrado por engano (ou em duplicidade). Ele
 *    não existiu, então sai do livro `payments`; a parcela vinculada reabre e
 *    o comprovante emitido para ele é removido junto. O histórico não precisa
 *    guardar um erro.
 *
 *  - ESTORNAR: o dinheiro entrou e depois voltou ao cliente. A entrada
 *    original é HISTÓRIA e fica intacta; a devolução entra como uma linha
 *    NEGATIVA no mesmo livro de caixa (o padrão que a transferência entre
 *    contas já usa), ligada ao original por `refund_of_payment_id`. Assim o
 *    recebido líquido cai, o saldo da reserva volta e o extrato mostra a saída.
 *
 * Nada de tabela paralela: `payments` continua sendo o único livro do caixa
 * realizado. Os totais do sistema são somas desse livro, então exclusão e
 * estorno refletem em Dashboard, Financeiro, extrato de conta e recibos sem
 * nenhum campo derivado guardado a ser corrigido à mão.
 *
 * A única coluna derivada que existe é `financial_entries.status`, e ela é
 * recalculada no MESMO batch da operação: o status é apenas um retrato da
 * soma dos pagamentos ligados à parcela, nunca uma verdade independente.
 */

type Pagamento = {
  id: number;
  reservation_id: number | null;
  freight_id: number | null;
  amount_cents: number;
  method: string;
  paid_at: string;
  notes: string | null;
  entry_id: number | null;
  account_id: number | null;
  transfer_group: string | null;
  refund_of_payment_id: number | null;
};

export type ResultadoOperacao =
  | {
      ok: true;
      /** Lançamento afetado (o excluído ou o recebimento estornado). */
      paymentId: number;
      /** Linha de estorno criada (só no estorno). */
      estornoId?: number;
      /** Valor movimentado, sempre positivo. */
      valorCents: number;
      reservationId: number | null;
      freightId: number | null;
    }
  /** `codigo` permite o chamador distinguir recusas de contrato (transferência). */
  | { erro: string; codigo?: "transferencia" };

/**
 * Status da parcela = comparação entre o valor previsto e a soma assinada dos
 * pagamentos ligados a ela. Rodar depois de excluir/estornar reabre a parcela
 * quitada e mantém quitada a que ainda está coberta.
 *
 * `status <> 'cancelada'` preserva o cancelamento manual da parcela.
 */
const RECALCULAR_PARCELA = `UPDATE financial_entries
   SET status = CASE
         WHEN COALESCE((SELECT SUM(p.amount_cents) FROM payments p WHERE p.entry_id = financial_entries.id), 0) >= financial_entries.amount_cents
           THEN 'quitada' ELSE 'aberta' END,
       updated_at = datetime('now','localtime')
 WHERE id = ? AND company_id = ? AND status <> 'cancelada'`;

/** Pagamento da empresa do usuário. IDOR: de outra empresa é "não existe". */
async function pagamentoDaEmpresa(paymentId: number, companyId: number) {
  return await one<Pagamento>(
    `SELECT id, reservation_id, freight_id, amount_cents, method, paid_at, notes,
            entry_id, account_id, transfer_group, refund_of_payment_id
       FROM payments WHERE id = ? AND company_id = ?`,
    [paymentId, companyId],
  );
}

/**
 * Predicado SQL de "recebimento vivo": positivo, sem lado de transferência e
 * sem estorno já emitido. Usado tanto na validação quanto nos próprios
 * statements, para que a trava valha também sob concorrência.
 */
const RECEBIMENTO_VIVO = `amount_cents > 0
   AND transfer_group IS NULL
   AND refund_of_payment_id IS NULL
   AND NOT EXISTS (SELECT 1 FROM payments x WHERE x.refund_of_payment_id = payments.id)`;

/** Transferência entre contas não é pagamento de reserva: tem fluxo próprio. */
const ERRO_TRANSFERENCIA =
  "Transferência entre contas não é excluída nem estornada por aqui. Use Financeiro › Transferências.";

/**
 * EXCLUIR: remove um lançamento registrado por engano.
 *
 * Transação única (batch): comprovante + lançamento + status da parcela. Se o
 * lançamento já não estiver mais no estado esperado (estornado ou apagado por
 * outra requisição), nenhum dos três muda e a operação responde com erro —
 * nada fica pela metade.
 */
export async function excluirPagamento(opts: {
  paymentId: number;
  companyId: number;
}): Promise<ResultadoOperacao> {
  const p = await pagamentoDaEmpresa(opts.paymentId, opts.companyId);
  if (!p) return { erro: "Lançamento não encontrado." };
  if (p.transfer_group != null) return { erro: ERRO_TRANSFERENCIA, codigo: "transferencia" };
  if (p.amount_cents < 0 || p.refund_of_payment_id != null) {
    return {
      erro: "Este lançamento é um estorno (devolução). Ele preserva o histórico e não pode ser excluído — exclua o recebimento original, se foi registrado por engano.",
    };
  }
  const jaEstornado = await one(
    `SELECT id FROM payments WHERE refund_of_payment_id = ? AND company_id = ?`,
    [p.id, opts.companyId],
  );
  if (jaEstornado) {
    return {
      erro: "Este recebimento já foi estornado. O estorno preserva o histórico; para cobrar de novo, registre um novo recebimento.",
    };
  }

  const statements: { sql: string; params?: any[] }[] = [
    // O comprovante do lançamento excluído não sobrevive: ele comprovava um
    // dinheiro que, por definição, nunca existiu. O DELETE tem a MESMA guarda
    // do lançamento abaixo, então numa corrida os dois statements são no-op.
    {
      sql: `DELETE FROM receipts
             WHERE company_id = ? AND source_type = 'payment' AND payment_id IN (
               SELECT id FROM payments
                WHERE id = ? AND company_id = ? AND ${RECEBIMENTO_VIVO}
             )`,
      params: [opts.companyId, p.id, opts.companyId],
    },
    {
      sql: `DELETE FROM payments WHERE id = ? AND company_id = ? AND ${RECEBIMENTO_VIVO}`,
      params: [p.id, opts.companyId],
    },
  ];
  if (p.entry_id) statements.push({ sql: RECALCULAR_PARCELA, params: [p.entry_id, opts.companyId] });

  const rs = await batch(statements);
  if (!Number(rs[1]?.meta?.changes ?? 0)) {
    return {
      erro: "O lançamento não foi excluído porque já foi alterado. Atualize a página e confira o histórico.",
    };
  }
  return {
    ok: true,
    paymentId: p.id,
    valorCents: Math.abs(p.amount_cents),
    reservationId: p.reservation_id,
    freightId: p.freight_id,
  };
}

/**
 * ESTORNAR: devolve ao cliente um valor que realmente entrou.
 *
 * A entrada original fica no histórico; a devolução é uma linha negativa
 * ligada a ela. O índice único `uq_payments_estorno_unico` (migration 0052)
 * garante UM estorno por recebimento mesmo com clique duplo ou requisição
 * concorrente: o segundo INSERT viola a restrição e o lote inteiro volta.
 */
export async function estornarPagamento(opts: {
  paymentId: number;
  companyId: number;
  userId: number;
  motivo?: string;
  /** Data da devolução (YYYY-MM-DD); vazio = hoje. */
  data?: string;
}): Promise<ResultadoOperacao> {
  const p = await pagamentoDaEmpresa(opts.paymentId, opts.companyId);
  if (!p) return { erro: "Lançamento não encontrado." };
  if (p.transfer_group != null) return { erro: ERRO_TRANSFERENCIA, codigo: "transferencia" };
  if (p.amount_cents <= 0) {
    return { erro: "Este lançamento já é um estorno. Só um recebimento pode ser estornado." };
  }
  const jaEstornado = await one(
    `SELECT id FROM payments WHERE refund_of_payment_id = ? AND company_id = ?`,
    [p.id, opts.companyId],
  );
  if (jaEstornado) return { erro: "Este recebimento já foi estornado." };

  const motivo = String(opts.motivo ?? "").trim().slice(0, 120);
  const data = /^\d{4}-\d{2}-\d{2}$/.test(String(opts.data ?? "")) ? String(opts.data) : today();
  // "Estorno" no início das observações é o que identifica o lançamento nos
  // extratos e o que impede a emissão de recibo de devolução (recibos.ts).
  const notas =
    `Estorno (devolução ao cliente)${motivo ? ` — ${motivo}` : ""}` +
    (p.notes ? `: ${p.notes}` : "");

  const statements: { sql: string; params?: any[] }[] = [
    {
      sql: `INSERT INTO payments
              (reservation_id, freight_id, amount_cents, method, paid_at, notes,
               entry_id, account_id, created_by, company_id, refund_of_payment_id)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      params: [
        p.reservation_id,
        p.freight_id,
        -Math.abs(p.amount_cents),
        p.method,
        data,
        notas.slice(0, 200),
        p.entry_id,
        p.account_id,
        opts.userId,
        opts.companyId,
        p.id,
      ],
    },
  ];
  if (p.entry_id) statements.push({ sql: RECALCULAR_PARCELA, params: [p.entry_id, opts.companyId] });

  let rs: Awaited<ReturnType<typeof batch>>;
  try {
    rs = await batch(statements);
  } catch (e) {
    // Corrida perdida no índice único: o estorno da outra requisição venceu.
    if (isUniqueViolation(e)) return { erro: "Este recebimento já foi estornado." };
    throw e;
  }

  return {
    ok: true,
    paymentId: p.id,
    estornoId: Number(rs[0]?.meta?.last_row_id ?? 0) || undefined,
    valorCents: Math.abs(p.amount_cents),
    reservationId: p.reservation_id,
    freightId: p.freight_id,
  };
}
