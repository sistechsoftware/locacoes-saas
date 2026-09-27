"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { all, insert, one, run, scalar } from "@/lib/db";
import { assertAdmin, requireUser } from "@/lib/auth";
import { logAction } from "@/lib/audit";
import { parseMoney, today } from "@/lib/format";
import { loadSpecs } from "@/lib/stock";
import { validateComposition, type Component } from "@/lib/kits";

function readProduct(fd: FormData) {
  const kind = String(fd.get("kind") ?? "simples") === "kit" ? "kit" : "simples";
  return {
    kind,
    code: String(fd.get("code") ?? "").trim().toUpperCase(),
    name: String(fd.get("name") ?? "").trim(),
    category_id: Number(fd.get("category_id")) || null,
    // Kit nao possui estoque proprio: a disponibilidade vem dos componentes.
    total_qty: kind === "kit" ? 0 : Math.max(0, Number(fd.get("total_qty")) || 0),
    min_qty: Math.max(0, Number(fd.get("min_qty")) || 0),
    rent_price_cents: parseMoney(String(fd.get("rent_price") ?? "")),
    replace_cents: parseMoney(String(fd.get("replace_price") ?? "")),
    description: String(fd.get("description") ?? "").trim(),
    photo: String(fd.get("photo") ?? "").trim(),
  };
}

/** Le a composicao enviada pelo formulario do kit. */
function readComponents(fd: FormData): Component[] {
  try {
    const raw = JSON.parse(String(fd.get("components") ?? "[]"));
    const merged = new Map<number, number>();
    for (const c of Array.isArray(raw) ? raw : []) {
      const productId = Number(c.product_id);
      const quantity = Number(c.quantity);
      if (!productId || !Number.isFinite(quantity)) continue;
      merged.set(productId, quantity);
    }
    return [...merged.entries()].map(([product_id, quantity]) => ({ product_id, quantity }));
  } catch {
    return [];
  }
}

/** Regrava a composicao do kit. */
async function saveComponents(parentId: number, components: Component[]) {
  await run(`DELETE FROM product_components WHERE parent_product_id = ?`, [parentId]);
  for (const c of components) {
    await insert(
      `INSERT INTO product_components (parent_product_id, component_product_id, quantity) VALUES (?,?,?)`,
      [parentId, c.product_id, c.quantity],
    );
  }
}

export async function createProduct(_prev: string | null, fd: FormData): Promise<string | null> {
  const user = await requireUser();
  const p = readProduct(fd);
  if (!p.name) return "Informe o nome do produto.";
  if (!p.code) return "Informe um codigo (ex.: MESA, CAD).";
  if (await scalar<number>(`SELECT COUNT(*) FROM products WHERE code = ?`, [p.code]) > 0)
    return "Já existe um produto com este código.";

  const components = readComponents(fd);
  if (p.kind === "kit") {
    const erro = validateComposition(null, components, await loadSpecs());
    if (erro) return erro;
  }

  const id = await insert(
    `INSERT INTO products (code, name, category_id, kind, total_qty, min_qty, rent_price_cents, replace_cents, description, photo)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [
      p.code,
      p.name,
      p.category_id,
      p.kind,
      p.total_qty,
      p.min_qty,
      p.rent_price_cents,
      p.replace_cents,
      p.description,
      p.photo,
    ],
  );
  if (p.kind === "kit") await saveComponents(id, components);

  await logAction(
    user,
    "criar",
    "produto",
    id,
    p.kind === "kit"
      ? `${user.name} cadastrou o kit ${p.name} (${components.length} componente(s))`
      : `${user.name} cadastrou o produto ${p.name} (${p.total_qty} un.)`,
  );
  revalidatePath("/estoque");
  redirect(`/estoque/${id}`);
}

export async function updateProduct(_prev: string | null, fd: FormData): Promise<string | null> {
  const user = await requireUser();
  const id = Number(fd.get("id"));
  const p = readProduct(fd);
  const current = await one<any>(`SELECT * FROM products WHERE id = ?`, [id]);
  if (!current) return "Produto não encontrado.";
  if (!p.name) return "Informe o nome do produto.";
  if (await scalar<number>(`SELECT COUNT(*) FROM products WHERE code = ? AND id <> ?`, [p.code, id]) > 0)
    return "Já existe outro produto com este código.";

  const components = readComponents(fd);
  if (p.kind === "kit") {
    const erro = validateComposition(id, components, await loadSpecs());
    if (erro) return erro;
  } else if (current.kind === "kit") {
    // virou produto simples: a composicao deixa de existir
    const usadoComoKit = await scalar<number>(
      `SELECT COUNT(*) FROM reservation_items WHERE product_id = ?`,
      [id],
    );
    if (usadoComoKit > 0) {
      return "Este kit já foi usado em reservas. Crie um produto novo em vez de convertê-lo em produto simples.";
    }
  }
  if (p.kind === "simples") {
    const ehComponente = await scalar<number>(
      `SELECT COUNT(*) FROM product_components WHERE parent_product_id = ?`,
      [id],
    );
    if (ehComponente > 0) await run(`DELETE FROM product_components WHERE parent_product_id = ?`, [id]);
  }

  await run(
    `UPDATE products SET code=?, name=?, category_id=?, kind=?, total_qty=?, min_qty=?, rent_price_cents=?, replace_cents=?,
            description=?, photo=? WHERE id = ?`,
    [
      p.code,
      p.name,
      p.category_id,
      p.kind,
      p.total_qty,
      p.min_qty,
      p.rent_price_cents,
      p.replace_cents,
      p.description,
      p.photo,
      id,
    ],
  );
  if (p.kind === "kit") await saveComponents(id, components);
  const mudouQtd = current.total_qty !== p.total_qty;
  await logAction(
    user,
    "editar",
    "produto",
    id,
    `${user.name} alterou o produto ${p.name}${mudouQtd ? ` (quantidade ${current.total_qty} para ${p.total_qty})` : ""}`,
  );
  revalidatePath(`/estoque/${id}`);
  redirect(`/estoque/${id}`);
}

export async function toggleProduct(fd: FormData) {
  const user = await assertAdmin();
  const id = Number(fd.get("id"));
  const p = await one<any>(`SELECT * FROM products WHERE id = ?`, [id]);
  if (!p) return;
  await run(`UPDATE products SET active = ? WHERE id = ?`, [p.active ? 0 : 1, id]);
  await logAction(user, p.active ? "inativar" : "reativar", "produto", id, `${user.name} ${p.active ? "inativou" : "reativou"} ${p.name}`);
  revalidatePath(`/estoque/${id}`);
}

export async function deleteProduct(fd: FormData) {
  const user = await assertAdmin();
  const id = Number(fd.get("id"));
  const p = await one<any>(`SELECT name FROM products WHERE id = ?`, [id]);
  const usado = await scalar<number>(
    `SELECT (SELECT COUNT(*) FROM reservation_items WHERE product_id = ?) + (SELECT COUNT(*) FROM quote_items WHERE product_id = ?)`,
    [id, id],
  );
  if (usado > 0) {
    await run(`UPDATE products SET active = 0 WHERE id = ?`, [id]);
    await logAction(user, "inativar", "produto", id, `${user.name} inativou ${p?.name} (usado em reservas)`);
    redirect(`/estoque/${id}?aviso=inativado`);
  }
  // produto que compoe algum kit nao pode sumir sem quebrar a composicao
  const emKits = await scalar<number>(`SELECT COUNT(*) FROM product_components WHERE component_product_id = ?`, [id]);
  if (emKits > 0) {
    await run(`UPDATE products SET active = 0 WHERE id = ?`, [id]);
    await logAction(user, "inativar", "produto", id, `${user.name} inativou ${p?.name} (compoe ${emKits} kit(s))`);
    redirect(`/estoque/${id}?aviso=componente`);
  }
  await run(`DELETE FROM product_components WHERE parent_product_id = ?`, [id]);
  await run(`DELETE FROM products WHERE id = ?`, [id]);
  await logAction(user, "excluir", "produto", id, `${user.name} excluiu o produto ${p?.name}`);
  redirect("/estoque");
}

/* ---------------------------- unidades individuais ---------------------------- */

export async function addUnits(fd: FormData) {
  const user = await requireUser();
  const productId = Number(fd.get("product_id"));
  const qty = Math.max(1, Math.min(200, Number(fd.get("qty")) || 1));
  const p = await one<any>(`SELECT * FROM products WHERE id = ?`, [productId]);
  if (!p) return;

  const last = await one<{ code: string }>(
    `SELECT code FROM product_units WHERE product_id = ? ORDER BY LENGTH(code) DESC, code DESC LIMIT 1`,
    [productId],
  );
  let seq = last ? Number(last.code.split("-").pop()) || 0 : 0;
  const value = parseMoney(String(fd.get("value") ?? "")) || p.replace_cents;

  for (let i = 0; i < qty; i++) {
    seq += 1;
    await insert(
      `INSERT INTO product_units (product_id, code, status, value_cents, acquired_at, condition)
       VALUES (?,?,?,?,?,?)`,
      [productId, `${p.code}-${String(seq).padStart(3, "0")}`, "disponivel", value, today(), "bom"],
    );
  }
  await logAction(user, "criar", "produto", productId, `${user.name} cadastrou ${qty} unidade(s) de ${p.name}`);
  revalidatePath(`/estoque/${productId}`);
}

export async function setUnitStatus(fd: FormData) {
  const user = await requireUser();
  const unitId = Number(fd.get("unit_id"));
  const status = String(fd.get("status"));
  const u = await one<any>(`SELECT u.*, p.name FROM product_units u JOIN products p ON p.id = u.product_id WHERE u.id = ?`, [
    unitId,
  ]);
  if (!u) return;
  await run(`UPDATE product_units SET status = ?, notes = COALESCE(NULLIF(?,''), notes) WHERE id = ?`, [
    status,
    String(fd.get("notes") ?? ""),
    unitId,
  ]);
  await logAction(user, "status", "produto", u.product_id, `${user.name} marcou ${u.code} como ${status}`);
  revalidatePath(`/estoque/${u.product_id}`);
}

export async function deleteUnit(fd: FormData) {
  const user = await assertAdmin();
  const unitId = Number(fd.get("unit_id"));
  const u = await one<any>(`SELECT * FROM product_units WHERE id = ?`, [unitId]);
  if (!u) return;
  await run(`DELETE FROM product_units WHERE id = ?`, [unitId]);
  await logAction(user, "excluir", "produto", u.product_id, `${user.name} removeu a unidade ${u.code}`);
  revalidatePath(`/estoque/${u.product_id}`);
}

/* -------------------------------- manutencao ---------------------------------- */

export async function openMaintenance(fd: FormData) {
  const user = await requireUser();
  const productId = Number(fd.get("product_id"));
  const qty = Math.max(1, Number(fd.get("qty")) || 1);
  const p = await one<any>(`SELECT * FROM products WHERE id = ?`, [productId]);
  if (!p) return;

  const id = await insert(
    `INSERT INTO maintenance (product_id, product_unit_id, qty, reason, started_at, status, cost_cents, notes, created_by)
     VALUES (?,?,?,?,?, 'aberta', ?,?,?)`,
    [
      productId,
      Number(fd.get("product_unit_id")) || null,
      qty,
      String(fd.get("reason") ?? ""),
      String(fd.get("started_at") ?? "") || today(),
      parseMoney(String(fd.get("cost") ?? "")),
      String(fd.get("notes") ?? ""),
      user.id,
    ],
  );
  await run(`UPDATE products SET maintenance_qty = MIN(total_qty, maintenance_qty + ?) WHERE id = ?`, [qty, productId]);
  const unitId = Number(fd.get("product_unit_id"));
  if (unitId) await run(`UPDATE product_units SET status = 'manutencao' WHERE id = ?`, [unitId]);

  await logAction(user, "manutencao", "produto", productId, `${user.name} enviou ${qty} un. de ${p.name} para manutencao`);
  revalidatePath(`/estoque/${productId}`);
}

export async function closeMaintenance(fd: FormData) {
  const user = await requireUser();
  const id = Number(fd.get("id"));
  const m = await one<any>(`SELECT m.*, p.name FROM maintenance m JOIN products p ON p.id = m.product_id WHERE m.id = ?`, [id]);
  if (!m || m.status !== "aberta") return;

  await run(`UPDATE maintenance SET status = 'concluida', ended_at = ? WHERE id = ?`, [today(), id]);
  await run(`UPDATE products SET maintenance_qty = MAX(0, maintenance_qty - ?) WHERE id = ?`, [m.qty, m.product_id]);
  if (m.product_unit_id) await run(`UPDATE product_units SET status = 'disponivel' WHERE id = ?`, [m.product_unit_id]);

  await logAction(user, "manutencao", "produto", m.product_id, `${user.name} concluiu a manutencao de ${m.qty} un. de ${m.name}`);
  revalidatePath(`/estoque/${m.product_id}`);
}

/* -------------------------------- categorias ---------------------------------- */

export async function createCategory(fd: FormData) {
  const user = await requireUser();
  const name = String(fd.get("name") ?? "").trim();
  if (!name) return;
  await run(`INSERT OR IGNORE INTO categories (name) VALUES (?)`, [name]);
  await logAction(user, "criar", "categoria", null, `${user.name} criou a categoria ${name}`);
  revalidatePath("/estoque");
  revalidatePath("/configuracoes");
}

export async function deleteCategory(fd: FormData) {
  const user = await assertAdmin();
  const id = Number(fd.get("id"));
  const usados = await scalar<number>(`SELECT COUNT(*) FROM products WHERE category_id = ?`, [id]);
  if (usados > 0) return;
  const c = await one<any>(`SELECT name FROM categories WHERE id = ?`, [id]);
  await run(`DELETE FROM categories WHERE id = ?`, [id]);
  await logAction(user, "excluir", "categoria", id, `${user.name} removeu a categoria ${c?.name}`);
  revalidatePath("/configuracoes");
}
