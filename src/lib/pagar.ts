import "server-only";
import { batch, nextNumber, one, run, scalar } from "./db";
import { montarParcelas } from "./financeiro";
import { today } from "./format";

/**
 * Contas a pagar criadas manualmente.
 *
 * Nao e um livro novo: e a mesma tabela `financial_entries` que o parcelamento
 * de compra ja alimenta, na mesma direcao 'pagar', com a mesma situacao
 * derivada de `situacaoParcela`. O que muda e so a origem do registro —
 * origin='despesa', valor que ja existe no CHECK da coluna desde a migration
 * do financeiro e que nenhuma tela usava.
 *
 * Um lancamento manual nunca toca em compra, estoque, reserva ou cliente: ele
 * apenas registra a obrigacao financeira. O dinheiro so sai da conta quando
 * alguem usa a baixa existente (payEntry), que grava em `expenses` — o mesmo
 * caminho de sempre, sem segunda logica de pagamento.
 *
 * As duas datas tem significados diferentes e nenhum valor preenche o outro:
 * purchase_date e a competencia (quando a despesa aconteceu) e due_date e o
 * vencimento (quando o dinheiro deve sair). Ex.: compra no cartao em 10/09
 * que so sera paga na fatura de 05/10.
 */

/** Valores permitidos pela coluna origin: 'despesa' marca o lancamento manual. */
export const ORIGEM_MANUAL = "despesa";

/** Categoria padrao de um lancamento manual, coerente com as parcelas de compra. */
export const CATEGORIA_PADRAO = "Compras";

const PARCELAS_MIN = 1;
const PARCELAS_MAX = 60;

export type NovoPagarInput = {
  descricao: string;
  /** Centavos, inteiro, ja validado. */
  amountCents: number;
  /** Competencia: quando a despesa aconteceu (YYYY-MM-DD). */
  purchaseDate: string;
  /** Quando o dinheiro deve sair (YYYY-MM-DD). */
  dueDate: string;
  parcelas: number;
  categoria?: string | null;
  supplierId?: number | null;
  accountId?: number | null;
  notes?: string | null;
  userId: number;
};

/** Data de calendario valida e nao vazia: o formato que o sistema inteiro usa. */
export function validarData(data: string, rotulo: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) return `Informe uma ${rotulo} válida.`;
  // rejeita dias impossiveis ("2026-02-31"): Date.UTC normaliza para o mes
  // seguinte, entao a ida e volta tem que bater com o que veio
  const [ano, mes, dia] = data.split("-").map(Number);
  const d = new Date(Date.UTC(ano, mes - 1, dia));
  if (d.getUTCFullYear() !== ano || d.getUTCMonth() !== mes - 1 || d.getUTCDate() !== dia) {
    return `Informe uma ${rotulo} válida.`;
  }
  return null;
}

/**
 * Valida os campos de um lancamento manual. Devolve o primeiro erro, ou null.
 *
 * Regras minimas pedidas: descricao obrigatoria, valor maior que zero e as
 * duas datas presentes e validas. Vencimento anterior a competencia e
 * permitido de proposito: acontece de verdade quando o usuario registra
 * depois a compra que ja venceu.
 */
export function validarPagar(i: NovoPagarInput): string | null {
  if (!i.descricao.trim()) return "Informe a descrição da conta.";
  if (!Number.isInteger(i.amountCents) || i.amountCents <= 0) {
    return "Informe um valor maior que zero.";
  }
  const erroCompra = validarData(i.purchaseDate, "data da compra");
  if (erroCompra) return erroCompra;
  const erroVenc = validarData(i.dueDate, "data de vencimento");
  if (erroVenc) return erroVenc;
  if (i.parcelas < PARCELAS_MIN || i.parcelas > PARCELAS_MAX) {
    return `O número de parcelas deve ficar entre ${PARCELAS_MIN} e ${PARCELAS_MAX}.`;
  }
  return null;
}

/**
 * Grava o lancamento (ou as parcelas dele) em financial_entries, em um unico
 * batch — a transacao real que o D1 oferece. Ou tudo entra, ou nada entra:
 * nao existe conta sem parcela, parcela sem numero nem meia gravacao.
 *
 * Toda parcela nasce em aberto. Nenhuma saida de caixa e criada aqui; isso e
 * papel da baixa existente, quando o pagamento acontecer de fato.
 */
export async function criarContaPagarManual(i: NovoPagarInput): Promise<{ id: number | null; erro: string | null }> {
  const erro = validarPagar(i);
  if (erro) return { id: null, erro };

  const parcelas = montarParcelas(i.amountCents, i.parcelas, i.dueDate);
  const multiplas = parcelas.length > 1;
  // nextNumber le o banco ANTES do batch rodar: chamada por parcela daria o
  // mesmo numero a todas e o lote morreria no UNIQUE. O sequencial e reservado
  // uma vez e incrementado em memoria, no mesmo formato PAG-XXX. nextNumber
  // ja devolve o PROXIMO numero livre (ultimo + 1), entao a primeira parcela
  // usa o valor como veio — somar 1 de novo pulava um numero.
  const baseSeq = parseInt((await nextNumber("financial_entries", "PAG")).split("-").pop() ?? "0", 10) || 0;
  const statements: { sql: string; params: any[] }[] = parcelas.map((p, idx) => ({
    sql: `INSERT INTO financial_entries
            (number, direction, origin, supplier_id, category, description,
             amount_cents, due_date, purchase_date, installment, installments_total,
             account_id, notes, created_by)
          VALUES (?,'pagar',?,?,?,?,?,?,?,?,?,?,?,?)`,
    params: [
      `PAG-${String(baseSeq + idx).padStart(3, "0")}`,
      ORIGEM_MANUAL,
      i.supplierId ?? null,
      i.categoria?.trim() || CATEGORIA_PADRAO,
      descricaoComParcela(i.descricao, p.installment, p.installments_total, multiplas),
      p.amount_cents,
      p.due_date,
      i.purchaseDate,
      p.installment,
      p.installments_total,
      i.accountId ?? null,
      i.notes?.trim() || null,
      i.userId,
    ],
  }));

  try {
    const results = await batch(statements);
    const firstId = Number(results[0]?.meta?.last_row_id ?? 0);
    return { id: firstId > 0 ? firstId : null, erro: null };
  } catch (e) {
    // o batch e atomico: se alguma parcela falhou, nada entrou. A causa real
    // volta para a tela (ex.: "no such column", FK de fornecedor inexistente)
    // em vez de uma mensagem generica que esconde o problema de verdade.
    return { id: null, erro: `Não foi possível gravar a conta. Nada foi lançado. Erro do banco: ${descricaoDoErro(e)}` };
  }
}

/** Mensagem legivel de um erro lancado pelo D1/SQLite, sem perder a causa. */
function descricaoDoErro(e: unknown): string {
  if (e instanceof Error && e.message) return e.message;
  return String(e);
}

/** Mesma convencao das parcelas de compra: "Descricao 2/3" so quando houver mais de uma. */
function descricaoComParcela(descricao: string, parcela: number, total: number, multiplas: boolean): string {
  return multiplas ? `${descricao} ${parcela}/${total}` : descricao;
}

/**
 * Cancela um lancamento manual ainda sem pagamento.
 *
 * O status 'cancelada' preserva o registro no historico, igual ao
 * cancelamento de parcelas de compra. Recusa quando ja existe saida de caixa
 * ligada: estornar o pagamento e outro fluxo, com confirmacao propria.
 */
export async function cancelarContaPagarManual(entryId: number): Promise<string | null> {
  const entry = await one<any>(`SELECT id, direction, origin, status, number FROM financial_entries WHERE id = ?`, [entryId]);
  if (!entry) return `Conta #${entryId || "?"} não encontrada.`;
  if (entry.direction !== "pagar" || entry.origin !== ORIGEM_MANUAL) {
    return "Somente contas lançadas manualmente podem ser canceladas aqui.";
  }

  const pago = await scalar<number>(`SELECT COALESCE(SUM(amount_cents),0) FROM expenses WHERE entry_id = ?`, [entryId]);
  if (pago !== 0) return "Esta conta já tem pagamento registrado. Estorne o pagamento antes de cancelar.";

  const r = await run(
    `UPDATE financial_entries SET status = 'cancelada', updated_at = datetime('now','localtime')
      WHERE id = ? AND status <> 'cancelada'`,
    [entryId],
  );
  if (!r.meta.changes) return "Esta conta já está cancelada.";
  return null;
}

/** Sugestao de competencia quando o usuario nao informa: hoje, no fuso do negocio. */
export function competenciaPadrao(data?: string | null): string {
  return data && /^\d{4}-\d{2}-\d{2}/.test(data) ? data.slice(0, 10) : today();
}
