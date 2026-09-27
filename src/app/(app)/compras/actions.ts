"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { all, insert, nextNumber, one, run, scalar } from "@/lib/db";
import { assertAdmin, requireUser } from "@/lib/auth";
import { logAction } from "@/lib/audit";
import { recalcPurchase, syncPurchaseEntries, syncPurchaseStock, vencimentoPadrao } from "@/lib/compras";
import { money, parseMoney, today } from "@/lib/format";

type ItemInput = { product_id: number; qty: number; unit_price_cents: number; discount_cents: number };

function readItems(fd: FormData): ItemInput[] {
  try {
    const raw = JSON.parse(String(fd.get("items") ?? "[]"));
    return (Array.isArray(raw) ? raw : [])
      .map((i: any) => ({
        product_id: Number(i.product_id),
        qty: Math.max(0, Number(i.qty) || 0),
        unit_price_cents: Number(i.unit_price_cents) || 0,
        discount_cents: Number(i.discount_cents) || 0,
      }))
      .filter((i) => i.product_id && i.qty > 0);
  } catch {
    return [];
  }
}

function readHeader(fd: FormData) {
  return {
    supplier_id: Number(fd.get("supplier_id")) || null,
    purchase_date: String(fd.get("purchase_date") ?? "").slice(0, 10) || today(),
    discount_cents: parseMoney(String(fd.get("discount") ?? "")),
    // compra historica registra o gasto passado sem tocar no estoque de hoje
    affects_stock: fd.get("affects_stock") === "1" ? 1 : 0,
    kind: String(fd.get("kind") ?? "investimento") === "operacional" ? "operacional" : "investimento",
    notes: String(fd.get("notes") ?? "").trim(),
    parcelas: Math.max(1, Math.min(60, Number(fd.get("parcelas")) || 1)),
    primeiro_vencimento: String(fd.get("primeiro_vencimento") ?? "").slice(0, 10),
    account_id: Number(fd.get("account_id")) || null,
  };
}

export async function createPurchase(_prev: string | null, fd: FormData): Promise<string | null> {
  const user = await requireUser();
  const h = readHeader(fd);
  const items = readItems(fd);
  if (!items.length) return "Adicione ao menos um item a compra.";

  const number = await nextNumber("purchases", "COMP");
  const id = await insert(
    `INSERT INTO purchases (number, supplier_id, purchase_date, discount_cents, affects_stock, kind, notes, created_by)
     VALUES (?,?,?,?,?,?,?,?)`,
    [number, h.supplier_id, h.purchase_date, h.discount_cents, h.affects_stock, h.kind, h.notes, user.id],
  );
  for (const i of items) {
    await insert(
      `INSERT INTO purchase_items (purchase_id, product_id, qty, unit_price_cents, discount_cents)
       VALUES (?,?,?,?,?)`,
      [id, i.product_id, i.qty, i.unit_price_cents, i.discount_cents],
    );
  }
  const total = await recalcPurchase(id);
  await syncPurchaseStock(id, user.id);
  await syncPurchaseEntries(id, {
    parcelas: h.parcelas,
    primeiroVencimento: h.primeiro_vencimento || vencimentoPadrao(h.purchase_date),
    accountId: h.account_id,
    userId: user.id,
  });

  await logAction(
    user,
    "criar",
    "compra",
    id,
    `${user.name} registrou a compra ${number} de ${money(total)}` +
      (h.affects_stock ? " (entrou no estoque)" : " (historica, sem mexer no estoque)"),
  );
  revalidatePath("/compras");
  revalidatePath("/financeiro");
  redirect(`/compras/${id}`);
}

export async function updatePurchase(_prev: string | null, fd: FormData): Promise<string | null> {
  const user = await requireUser();
  const id = Number(fd.get("id"));
  const h = readHeader(fd);
  const items = readItems(fd);
  const atual = await one<any>(`SELECT * FROM purchases WHERE id = ?`, [id]);
  if (!atual) return "Compra não encontrada.";
  if (atual.status === "cancelada") return "Compra cancelada não pode ser editada.";
  if (!items.length) return "A compra precisa ter ao menos um item.";

  // preserva o quanto ja entrou no estoque de cada produto, para que a
  // regravacao movimente apenas a diferenca em vez de somar tudo de novo
  const aplicado = new Map<number, number>();
  for (const i of await all<any>(`SELECT product_id, stock_applied_qty FROM purchase_items WHERE purchase_id = ?`, [id])) {
    aplicado.set(i.product_id, (aplicado.get(i.product_id) ?? 0) + i.stock_applied_qty);
  }

  await run(
    `UPDATE purchases SET supplier_id=?, purchase_date=?, discount_cents=?, affects_stock=?, kind=?, notes=?,
            updated_at=datetime('now','localtime') WHERE id = ?`,
    [h.supplier_id, h.purchase_date, h.discount_cents, h.affects_stock, h.kind, h.notes, id],
  );
  await run(`DELETE FROM purchase_items WHERE purchase_id = ?`, [id]);
  for (const i of items) {
    // a primeira linha de cada produto herda todo o aplicado dele, para que o
    // sync veja a diferenca; as demais linhas do mesmo produto comecam do zero
    const herdado = aplicado.get(i.product_id) ?? 0;
    aplicado.set(i.product_id, 0);
    await insert(
      `INSERT INTO purchase_items (purchase_id, product_id, qty, unit_price_cents, discount_cents, stock_applied_qty)
       VALUES (?,?,?,?,?,?)`,
      [id, i.product_id, i.qty, i.unit_price_cents, i.discount_cents, herdado],
    );
  }

  // produto retirado da compra nao tem mais linha para o sync ajustar, entao o
  // que ele havia somado ao estoque e estornado aqui
  for (const [productId, sobra] of aplicado) {
    if (sobra <= 0) continue;
    await run(`UPDATE products SET total_qty = MAX(0, total_qty - ?) WHERE id = ?`, [sobra, productId]);
    await insert(
      `INSERT INTO stock_movements (product_id, qty_delta, reason, purchase_id, notes, created_by)
       VALUES (?,?,'estorno_compra',?,?,?)`,
      [productId, -sobra, id, `Item removido da compra ${atual.number}`, user.id],
    );
  }

  const total = await recalcPurchase(id);
  await syncPurchaseStock(id, user.id);
  const erro = await syncPurchaseEntries(id, {
    parcelas: h.parcelas,
    primeiroVencimento: h.primeiro_vencimento || vencimentoPadrao(h.purchase_date),
    accountId: h.account_id,
    userId: user.id,
  });

  await logAction(user, "editar", "compra", id, `${user.name} alterou a compra ${atual.number} (${money(total)})`);
  revalidatePath(`/compras/${id}`);
  revalidatePath("/financeiro");
  if (erro) redirect(`/compras/${id}?aviso=${encodeURIComponent(erro)}`);
  redirect(`/compras/${id}`);
}

/** Cancela a compra: estorna o estoque e derruba as parcelas ainda em aberto. */
export async function cancelPurchase(fd: FormData) {
  const user = await assertAdmin();
  const id = Number(fd.get("id"));
  const compra = await one<any>(`SELECT * FROM purchases WHERE id = ?`, [id]);
  if (!compra || compra.status === "cancelada") return;

  const pago = await scalar<number>(
    `SELECT COALESCE(SUM(amount_cents),0) FROM expenses WHERE purchase_id = ?`,
    [id],
  );
  if (pago > 0) {
    redirect(
      `/compras/${id}?aviso=${encodeURIComponent(
        `Esta compra ja tem ${money(pago)} pago. Estorne os pagamentos antes de cancelar.`,
      )}`,
    );
  }

  await run(`UPDATE purchases SET status = 'cancelada', updated_at = datetime('now','localtime') WHERE id = ?`, [id]);
  await syncPurchaseStock(id, user.id);
  await run(`UPDATE financial_entries SET status = 'cancelada' WHERE purchase_id = ?`, [id]);

  await logAction(user, "cancelar", "compra", id, `${user.name} cancelou a compra ${compra.number} e estornou o estoque`);
  revalidatePath(`/compras/${id}`);
  revalidatePath("/financeiro");
  // volta para a URL limpa: senao um aviso de uma tentativa anterior fica na tela
  redirect(`/compras/${id}`);
}

/* ------------------------------------------------------------------ */
/* Pagamento de parcelas                                               */
/* ------------------------------------------------------------------ */

/**
 * Registra a saida de caixa de uma parcela.
 *
 * O lancamento vai para expenses, que continua sendo o unico livro de saidas,
 * ligado a parcela pelo entry_id. A parcela nao guarda "valor pago": ele e a
 * soma destes lancamentos, entao previsto e realizado nao podem divergir.
 */
export async function payEntry(fd: FormData) {
  const user = await requireUser();
  const entryId = Number(fd.get("entry_id"));
  const valor = parseMoney(String(fd.get("amount") ?? ""));
  const entry = await one<any>(`SELECT * FROM financial_entries WHERE id = ?`, [entryId]);
  if (!entry) return;

  const destino = entry.purchase_id ? `/compras/${entry.purchase_id}` : "/financeiro?aba=pagar";
  if (valor <= 0) redirect(`${destino}?aviso=${encodeURIComponent("Informe um valor válido.")}`);

  await insert(
    `INSERT INTO expenses (date, category, description, amount_cents, method, status, entry_id, account_id,
                           supplier_id, purchase_id, kind, created_by)
     VALUES (?,?,?,?,?,'pago',?,?,?,?,?,?)`,
    [
      String(fd.get("paid_at") ?? "") || today(),
      entry.category || "Compras",
      entry.description,
      valor,
      String(fd.get("method") ?? "pix"),
      entryId,
      Number(fd.get("account_id")) || entry.account_id,
      entry.supplier_id,
      entry.purchase_id,
      entry.category === "Investimentos" ? "investimento" : "operacional",
      user.id,
    ],
  );

  const pago = await scalar<number>(`SELECT COALESCE(SUM(amount_cents),0) FROM expenses WHERE entry_id = ?`, [entryId]);
  if (pago >= entry.amount_cents) {
    await run(`UPDATE financial_entries SET status = 'quitada' WHERE id = ?`, [entryId]);
  }

  await logAction(user, "pagamento", "financeiro", entryId, `${user.name} pagou ${money(valor)} da parcela ${entry.number}`);
  revalidatePath(destino);
  revalidatePath("/financeiro");
}

/** Estorna um pagamento, mantendo o registro do estorno no historico. */
export async function reverseExpense(fd: FormData) {
  const user = await assertAdmin();
  const expenseId = Number(fd.get("expense_id"));
  const despesa = await one<any>(`SELECT * FROM expenses WHERE id = ?`, [expenseId]);
  if (!despesa) return;

  await insert(
    `INSERT INTO expenses (date, category, description, amount_cents, method, status, entry_id, account_id,
                           supplier_id, purchase_id, kind, created_by)
     VALUES (?,?,?,?,?,'estorno',?,?,?,?,?,?)`,
    [
      today(),
      despesa.category,
      `Estorno: ${despesa.description ?? ""}`.trim(),
      -despesa.amount_cents,
      despesa.method,
      despesa.entry_id,
      despesa.account_id,
      despesa.supplier_id,
      despesa.purchase_id,
      despesa.kind,
      user.id,
    ],
  );
  if (despesa.entry_id) {
    await run(`UPDATE financial_entries SET status = 'aberta' WHERE id = ?`, [despesa.entry_id]);
  }

  await logAction(
    user,
    "estorno",
    "financeiro",
    despesa.entry_id ?? expenseId,
    `${user.name} estornou um pagamento de ${money(despesa.amount_cents)}`,
  );
  revalidatePath("/financeiro");
  if (despesa.purchase_id) revalidatePath(`/compras/${despesa.purchase_id}`);
}

/* ------------------------------------------------------------------ */
/* Fornecedores e contas                                               */
/* ------------------------------------------------------------------ */

export async function createSupplier(fd: FormData) {
  const user = await requireUser();
  const name = String(fd.get("name") ?? "").trim();
  if (!name) return;
  const id = await insert(`INSERT INTO suppliers (name, doc, phone, email, notes) VALUES (?,?,?,?,?)`, [
    name,
    String(fd.get("doc") ?? "").trim(),
    String(fd.get("phone") ?? "").trim(),
    String(fd.get("email") ?? "").trim(),
    String(fd.get("notes") ?? "").trim(),
  ]);
  await logAction(user, "criar", "fornecedor", id, `${user.name} cadastrou o fornecedor ${name}`);
  revalidatePath("/configuracoes");
  revalidatePath("/compras");
}

export async function createAccount(fd: FormData) {
  const user = await assertAdmin();
  const name = String(fd.get("name") ?? "").trim();
  if (!name) return;
  const id = await insert(
    `INSERT INTO financial_accounts (name, kind, bank, initial_balance_cents, notes) VALUES (?,?,?,?,?)`,
    [
      name,
      String(fd.get("kind") ?? "banco"),
      String(fd.get("bank") ?? "").trim(),
      parseMoney(String(fd.get("initial_balance") ?? "")),
      String(fd.get("notes") ?? "").trim(),
    ],
  );
  await logAction(user, "criar", "conta", id, `${user.name} cadastrou a conta ${name}`);
  revalidatePath("/configuracoes");
  revalidatePath("/financeiro");
}
