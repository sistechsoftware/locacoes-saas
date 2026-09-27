import "server-only";
import { all, insert, nextNumber, one, run, scalar } from "./db";
import { ajusteDeEstoque, montarParcelas, subtotaisCompra, type ItemCompra } from "./financeiro";
import { today } from "./format";

/**
 * Compras e o que elas movimentam.
 *
 * Uma compra toca tres coisas ao mesmo tempo: o registro da compra, o estoque
 * (quando for compra atual) e o financeiro (as parcelas a pagar). As tres
 * precisam continuar coerentes depois de editar, reabrir ou cancelar, e e isso
 * que este modulo garante.
 */

export type ItemEntrada = {
  product_id: number;
  qty: number;
  unit_price_cents: number;
  discount_cents: number;
};

export async function recalcPurchase(purchaseId: number) {
  const itens = await all<ItemCompra & { id: number }>(
    `SELECT id, qty, unit_price_cents, discount_cents FROM purchase_items WHERE purchase_id = ?`,
    [purchaseId],
  );
  await run(
    `UPDATE purchase_items SET subtotal_cents = MAX(0, qty * unit_price_cents - discount_cents)
      WHERE purchase_id = ?`,
    [purchaseId],
  );
  const desconto = await scalar<number>(`SELECT discount_cents FROM purchases WHERE id = ?`, [purchaseId]);
  const { itensTotal, total } = subtotaisCompra(itens, desconto);
  await run(
    `UPDATE purchases SET items_cents = ?, total_cents = ?, updated_at = datetime('now','localtime') WHERE id = ?`,
    [itensTotal, total, purchaseId],
  );
  return total;
}

/**
 * Aplica ao estoque a diferenca entre o que a compra pede e o que ela ja
 * aplicou antes.
 *
 * Reabrir e salvar a mesma compra nao movimenta nada; mudar de 5 para 7 entra
 * com 2; cancelar devolve o que entrou. Cada movimento fica registrado em
 * stock_movements com a compra de origem, entao nada some do historico.
 */
export async function syncPurchaseStock(purchaseId: number, userId?: number) {
  const compra = await one<any>(`SELECT id, number, affects_stock, status FROM purchases WHERE id = ?`, [purchaseId]);
  if (!compra) return [];

  const itens = await all<any>(
    `SELECT id, product_id, qty, stock_applied_qty FROM purchase_items WHERE purchase_id = ?`,
    [purchaseId],
  );
  // compra cancelada ou historica tem alvo zero: a primeira estorna, a segunda nunca aplicou
  const aplicar = !!compra.affects_stock && compra.status !== "cancelada";
  const ajustes = ajusteDeEstoque(itens, aplicar);

  for (const a of ajustes) {
    await run(`UPDATE products SET total_qty = MAX(0, total_qty + ?) WHERE id = ?`, [a.delta, a.product_id]);
    await insert(
      `INSERT INTO stock_movements (product_id, qty_delta, reason, purchase_id, notes, created_by)
       VALUES (?,?,?,?,?,?)`,
      [
        a.product_id,
        a.delta,
        a.delta > 0 ? "compra" : "estorno_compra",
        purchaseId,
        `Compra ${compra.number}`,
        userId ?? null,
      ],
    );
  }

  // marca o aplicado para que a proxima gravacao so veja a diferenca
  for (const i of itens) {
    const alvo = aplicar ? i.qty : 0;
    if (i.stock_applied_qty !== alvo) {
      await run(`UPDATE purchase_items SET stock_applied_qty = ? WHERE id = ?`, [alvo, i.id]);
    }
  }
  return ajustes;
}

/**
 * Regrava as parcelas a pagar da compra.
 *
 * Parcelas ja quitadas nao sao tocadas: refazer o parcelamento de uma compra
 * meio paga apagaria pagamento registrado. Nesse caso a funcao recusa e devolve
 * o motivo, para a tela avisar em vez de destruir historico em silencio.
 */
export async function syncPurchaseEntries(
  purchaseId: number,
  opts: { parcelas: number; primeiroVencimento: string; accountId?: number | null; userId?: number },
): Promise<string | null> {
  const compra = await one<any>(
    `SELECT p.*, s.name AS supplier_name FROM purchases p LEFT JOIN suppliers s ON s.id = p.supplier_id WHERE p.id = ?`,
    [purchaseId],
  );
  if (!compra) return "Compra não encontrada.";

  const quitadas = await scalar<number>(
    `SELECT COUNT(*) FROM financial_entries e
      WHERE e.purchase_id = ?
        AND COALESCE((SELECT SUM(x.amount_cents) FROM expenses x WHERE x.entry_id = e.id),0) > 0`,
    [purchaseId],
  );
  if (quitadas > 0) {
    return "Esta compra já tem parcela paga. Cancele o pagamento antes de refazer o parcelamento.";
  }

  await run(`DELETE FROM financial_entries WHERE purchase_id = ?`, [purchaseId]);
  if (compra.status === "cancelada" || compra.total_cents <= 0) return null;

  const parcelas = montarParcelas(compra.total_cents, opts.parcelas, opts.primeiroVencimento);
  for (const p of parcelas) {
    const numero = await nextNumber("financial_entries", "PAG");
    await insert(
      `INSERT INTO financial_entries
        (number, direction, origin, supplier_id, purchase_id, category, description,
         amount_cents, due_date, installment, installments_total, account_id, created_by)
       VALUES (?,'pagar','compra',?,?,?,?,?,?,?,?,?,?)`,
      [
        numero,
        compra.supplier_id,
        purchaseId,
        compra.kind === "investimento" ? "Investimentos" : "Compras",
        `Compra ${compra.number}${parcelas.length > 1 ? ` ${p.installment}/${p.installments_total}` : ""}` +
          (compra.supplier_name ? ` - ${compra.supplier_name}` : ""),
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

/* ------------------------------------------------------------------ */
/* Leitura                                                             */
/* ------------------------------------------------------------------ */

export const PURCHASE_SELECT = `
  SELECT p.*, s.name AS supplier_name,
         (SELECT COUNT(*) FROM purchase_items i WHERE i.purchase_id = p.id) AS item_count,
         (SELECT COALESCE(SUM(i.qty),0) FROM purchase_items i WHERE i.purchase_id = p.id) AS item_qty,
         (SELECT COUNT(*) FROM financial_entries e WHERE e.purchase_id = p.id) AS parcelas,
         (SELECT COALESCE(SUM(x.amount_cents),0) FROM expenses x WHERE x.purchase_id = p.id) AS pago_cents
    FROM purchases p
    LEFT JOIN suppliers s ON s.id = p.supplier_id`;

export async function getPurchase(id: number) {
  return await one<any>(`${PURCHASE_SELECT} WHERE p.id = ?`, [id]);
}

export async function purchaseItems(id: number) {
  return await all<any>(
    `SELECT i.*, pr.name AS product_name, pr.code AS product_code, pr.kind AS product_kind
       FROM purchase_items i JOIN products pr ON pr.id = i.product_id
      WHERE i.purchase_id = ? ORDER BY i.id`,
    [id],
  );
}

export async function purchaseEntries(id: number) {
  return await all<any>(
    `SELECT e.*,
            COALESCE((SELECT SUM(x.amount_cents) FROM expenses x WHERE x.entry_id = e.id),0) AS pago_cents
       FROM financial_entries e
      WHERE e.purchase_id = ? ORDER BY e.installment`,
    [id],
  );
}

export async function purchaseStockMovements(id: number) {
  return await all<any>(
    `SELECT m.*, p.name AS product_name FROM stock_movements m
       JOIN products p ON p.id = m.product_id
      WHERE m.purchase_id = ? ORDER BY m.id`,
    [id],
  );
}

/** Fornecedores ativos, para os seletores. */
export async function activeSuppliers() {
  return await all<any>(`SELECT id, name FROM suppliers WHERE active = 1 ORDER BY name`);
}

/** Contas financeiras ativas, para os seletores. */
export async function activeAccounts() {
  return await all<any>(`SELECT id, name, kind FROM financial_accounts WHERE active = 1 ORDER BY name`);
}

/** Sugestao de vencimento quando o usuario nao informa: a data da compra. */
export function vencimentoPadrao(dataCompra?: string | null): string {
  return dataCompra && /^\d{4}-\d{2}-\d{2}/.test(dataCompra) ? dataCompra.slice(0, 10) : today();
}
