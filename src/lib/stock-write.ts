import "server-only";
import { batch, nextNumber, one, scalar } from "./db";
import { explodeLine, isKit, loadSpecs } from "./stock";

type Statement = { sql: string; params?: any[] };
export type RentalItem = { product_id: number; qty: number; unit_price_cents?: number; discount_cents?: number };
export const STOCK_CHANGED = "O estoque ou a reserva mudou durante a verificacao. Nada foi alterado; confira os dados e tente novamente.";

export async function stockVersion(): Promise<number> {
  return scalar<number>("SELECT revision FROM stock_revision WHERE id = 1");
}

/** Compare-and-swap plus ALL occupancy writes in one real D1 transaction. */
export async function commitStockBatch(version: number, statements: Statement[]) {
  try {
    return await batch([
      { sql: "INSERT INTO stock_write_guard(id) VALUES(CASE WHEN (SELECT revision FROM stock_revision WHERE id=1)=? THEN 1 ELSE 0 END)", params: [version] },
      ...statements,
      { sql: "DELETE FROM stock_write_guard WHERE id=1" },
    ]);
  } catch (e) {
    if (String(e).includes("stock_version_matches")) throw new Error(STOCK_CHANGED);
    throw e;
  }
}

const HEADER_COLUMNS = new Set([
  "customer_id", "status", "event_date", "event_time", "address", "district", "city", "delivery_at", "pickup_at",
  "needs_delivery", "needs_pickup", "needs_assembly", "needs_disassembly", "freight_cents", "assembly_cents",
  "disassembly_cents", "other_cents", "discount_cents", "notes", "stock_override", "stock_consider_preparation", "quote_id", "created_by",
]);

/** Preflight MUST happen after capturing version and before this commit.
 * Explicit IDs are safe under the revision guard; no partial header/items are
 * visible and a failed edit leaves the ORIGINAL rental completely intact.
 */
export async function writeRental(version: number, header: Record<string, any>, items: RentalItem[], existingId?: number, quoteId?: number) {
  const id = existingId ?? (Number(await scalar("SELECT COALESCE(seq,0) FROM sqlite_sequence WHERE name='reservations'")) + 1);
  const number = existingId ? (await one<any>("SELECT number FROM reservations WHERE id=?", [id]))?.number : await nextNumber("reservations", "LIMA");
  const fields = Object.entries(header).filter(([key]) => HEADER_COLUMNS.has(key));
  const statements: Statement[] = existingId ? [
    { sql: `UPDATE reservations SET ${fields.map(([key]) => key + "=?").join(",")}, updated_at=datetime('now') WHERE id=?`, params: [...fields.map(([,v]) => v), id] },
    { sql: "DELETE FROM reservation_item_components WHERE reservation_id=?", params: [id] },
    { sql: "DELETE FROM reservation_items WHERE reservation_id=?", params: [id] },
  ] : [
    { sql: `INSERT INTO reservations(id,number,${fields.map(([key]) => key).join(",")}) VALUES(?,?,${fields.map(() => "?").join(",")})`, params: [id, number, ...fields.map(([,v]) => v)] },
  ];
  const specs = await loadSpecs();
  let itemId = Number(await scalar("SELECT COALESCE(seq,0) FROM sqlite_sequence WHERE name='reservation_items'"));
  for (const item of items) {
    itemId++;
    statements.push({ sql: "INSERT INTO reservation_items(id,reservation_id,product_id,qty,unit_price_cents,discount_cents) VALUES(?,?,?,?,?,?)", params: [itemId,id,item.product_id,item.qty,item.unit_price_cents ?? 0,item.discount_cents ?? 0] });
    const spec = specs.get(item.product_id);
    for (const part of explodeLine(item, specs)) {
      const perUnit = isKit(spec) ? spec!.components.find(c => c.product_id === part.product_id)!.quantity : 1;
      statements.push({ sql: "INSERT INTO reservation_item_components(reservation_id,reservation_item_id,product_id,qty_per_unit,qty) VALUES(?,?,?,?,?)", params: [id,itemId,part.product_id,perUnit,part.qty] });
    }
  }
  if (quoteId) statements.push({ sql: "UPDATE quotes SET status='convertido',reservation_id=? WHERE id=? AND reservation_id IS NULL", params: [id,quoteId] });
  await commitStockBatch(version, statements);
  return { id, number };
}
