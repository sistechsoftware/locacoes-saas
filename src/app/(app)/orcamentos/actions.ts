"use server";
import { windowError } from "@/lib/availability-time";
import { stockVersion, writeRental, STOCK_CHANGED } from "@/lib/stock-write";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { all, insert, nextNumber, one, run, tx } from "@/lib/db";
import { assertAdmin, requireUser } from "@/lib/auth";
import { logAction } from "@/lib/audit";
import { recalcQuote, recalcReservation, syncOperations } from "@/lib/reservations";
import { checkConflicts, conflictsMessage, rebuildReservationComponents, stamp } from "@/lib/stock";
import { parseMoney } from "@/lib/format";

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
  const event_date = String(fd.get("event_date") ?? "").slice(0, 10);
  return {
    customer_id: Number(fd.get("customer_id")),
    event_date,
    event_time: String(fd.get("event_time") ?? ""),
    address: String(fd.get("address") ?? "").trim(),
    district: String(fd.get("district") ?? "").trim(),
    city: String(fd.get("city") ?? "").trim(),
    delivery_at: stamp(String(fd.get("delivery_at") ?? "") || event_date, "08:00"),
    pickup_at: stamp(String(fd.get("pickup_at") ?? "") || event_date, "18:00"),
    valid_until: String(fd.get("valid_until") ?? ""),
    freight_cents: parseMoney(String(fd.get("freight") ?? "")),
    assembly_cents: parseMoney(String(fd.get("assembly") ?? "")),
    disassembly_cents: parseMoney(String(fd.get("disassembly") ?? "")),
    other_cents: parseMoney(String(fd.get("other") ?? "")),
    discount_cents: parseMoney(String(fd.get("discount") ?? "")),
    notes: String(fd.get("notes") ?? "").trim(),
    status: String(fd.get("status") ?? "rascunho"),
  };
}

export async function createQuote(_prev: string | null, fd: FormData): Promise<string | null> {
  const user = await requireUser();
  let h: ReturnType<typeof readHeader>;
  try { h = readHeader(fd); } catch (e) { return (e as Error).message; }
  const invalidWindow = windowError(h.delivery_at, h.pickup_at);
  if (invalidWindow) return invalidWindow;
  const items = readItems(fd);
  if (!h.customer_id) return "Selecione o cliente.";
  if (!items.length) return "Adicione ao menos um item.";

  let id = 0;
  await tx(async () => {
    const number = await nextNumber("quotes", "ORC");
    id = await insert(
      `INSERT INTO quotes (number, customer_id, status, event_date, event_time, address, district, city,
        delivery_at, pickup_at, valid_until, freight_cents, assembly_cents, disassembly_cents, other_cents,
        discount_cents, notes, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        number,
        h.customer_id,
        h.status,
        h.event_date,
        h.event_time,
        h.address,
        h.district,
        h.city,
        h.delivery_at,
        h.pickup_at,
        h.valid_until,
        h.freight_cents,
        h.assembly_cents,
        h.disassembly_cents,
        h.other_cents,
        h.discount_cents,
        h.notes,
        user.id,
      ],
    );
    for (const i of items) {
      await insert(`INSERT INTO quote_items (quote_id, product_id, qty, unit_price_cents, discount_cents) VALUES (?,?,?,?,?)`, [
        id,
        i.product_id,
        i.qty,
        i.unit_price_cents,
        i.discount_cents,
      ]);
    }
    await recalcQuote(id);
    await logAction(user, "criar", "orcamento", id, `${user.name} criou o orcamento ${number}`);
  });

  await run(`UPDATE quotes SET stock_consider_preparation = ? WHERE id = ?`, [fd.get("consider_preparation") === "0" ? 0 : 1, id]);
  revalidatePath("/orcamentos");
  redirect(`/orcamentos/${id}`);
}

export async function updateQuote(_prev: string | null, fd: FormData): Promise<string | null> {
  const user = await requireUser();
  const id = Number(fd.get("id"));
  let h: ReturnType<typeof readHeader>;
  try { h = readHeader(fd); } catch (e) { return (e as Error).message; }
  const invalidWindow = windowError(h.delivery_at, h.pickup_at);
  if (invalidWindow) return invalidWindow;
  const items = readItems(fd);
  const q = await one<any>(`SELECT * FROM quotes WHERE id = ?`, [id]);
  if (!q) return "Orçamento não encontrado.";
  if (q.status === "convertido") return "Orçamento já convertido em reserva não pode ser alterado.";
  if (!items.length) return "Adicione ao menos um item.";

  await tx(async () => {
    await run(
      `UPDATE quotes SET customer_id=?, status=?, event_date=?, event_time=?, address=?, district=?, city=?,
              delivery_at=?, pickup_at=?, valid_until=?, freight_cents=?, assembly_cents=?, disassembly_cents=?,
              other_cents=?, discount_cents=?, notes=?, updated_at=datetime('now','localtime')
        WHERE id = ?`,
      [
        h.customer_id,
        h.status,
        h.event_date,
        h.event_time,
        h.address,
        h.district,
        h.city,
        h.delivery_at,
        h.pickup_at,
        h.valid_until,
        h.freight_cents,
        h.assembly_cents,
        h.disassembly_cents,
        h.other_cents,
        h.discount_cents,
        h.notes,
        id,
      ],
    );
    await run(`DELETE FROM quote_items WHERE quote_id = ?`, [id]);
    for (const i of items) {
      await insert(`INSERT INTO quote_items (quote_id, product_id, qty, unit_price_cents, discount_cents) VALUES (?,?,?,?,?)`, [
        id,
        i.product_id,
        i.qty,
        i.unit_price_cents,
        i.discount_cents,
      ]);
    }
    await recalcQuote(id);
    await logAction(user, "editar", "orcamento", id, `${user.name} alterou o orcamento ${q.number}`);
  });

  revalidatePath(`/orcamentos/${id}`);
  await run(`UPDATE quotes SET stock_consider_preparation = ? WHERE id = ?`, [fd.get("consider_preparation") === "0" ? 0 : 1, id]);
  redirect(`/orcamentos/${id}`);
}

export async function setQuoteStatus(fd: FormData) {
  const user = await requireUser();
  const id = Number(fd.get("id"));
  const status = String(fd.get("status"));
  const q = await one<any>(`SELECT * FROM quotes WHERE id = ?`, [id]);
  if (!q || q.status === "convertido") return;
  await run(`UPDATE quotes SET status = ?, updated_at = datetime('now','localtime') WHERE id = ?`, [status, id]);
  await logAction(user, "status", "orcamento", id, `${user.name} marcou o orcamento ${q.number} como ${status}`);
  revalidatePath(`/orcamentos/${id}`);
}

/** Converte o orcamento em reserva mantendo todos os dados e itens. */
export async function convertQuote(fd: FormData) {
  const user = await requireUser();
  const version = await stockVersion();
  const id = Number(fd.get("id"));
  const force = fd.get("override") === "1";
  const q = await one<any>(`SELECT * FROM quotes WHERE id = ?`, [id]);
  if (!q) return;
  if (q.reservation_id) redirect(`/reservas/${q.reservation_id}`);
  const invalidWindow = windowError(q.delivery_at, q.pickup_at);
  if (invalidWindow) redirect(`/orcamentos/${id}?erro=${encodeURIComponent(invalidWindow)}`);

  const items = await all<any>(`SELECT * FROM quote_items WHERE quote_id = ?`, [id]);
  if (!items.length) redirect(`/orcamentos/${id}?erro=${encodeURIComponent("Orcamento sem itens.")}`);

  const conflicts = await checkConflicts(
    items.map((i) => ({ product_id: i.product_id, qty: i.qty })),
    q.delivery_at,
    q.pickup_at,
    null,
    { considerPreparation: fd.has("consider_preparation") ? fd.get("consider_preparation") !== "0" : q.stock_consider_preparation !== 0 },
  );
  if (conflicts.length && !(force && user.role === "admin")) {
    const msg = conflictsMessage(conflicts);
    redirect(`/orcamentos/${id}?erro=${encodeURIComponent(msg)}`);
  }

  const considerPreparation = fd.has("consider_preparation") ? fd.get("consider_preparation") !== "0" : q.stock_consider_preparation !== 0;
  let saved: { id: number; number: string };
  try {
    saved = await writeRental(version, { ...q, status: "confirmada", quote_id: id, created_by: user.id,
      needs_delivery: 1, needs_pickup: 1, needs_assembly: q.assembly_cents > 0 ? 1 : 0,
      needs_disassembly: q.disassembly_cents > 0 ? 1 : 0, stock_override: force && user.role === "admin" ? 1 : 0,
      stock_consider_preparation: considerPreparation ? 1 : 0 }, items, undefined, id);
  } catch (e) {
    if ((e as Error).message === STOCK_CHANGED) redirect(`/orcamentos/${id}?erro=${encodeURIComponent(STOCK_CHANGED)}`);
    throw e;
  }
  const { id: reservationId, number } = saved;
  await insert("INSERT INTO deposits (reservation_id,amount_cents,status) VALUES (?,0,'nao_recebida')", [reservationId]);
  await recalcReservation(reservationId);
  await syncOperations(reservationId);
  await logAction(user, "converter", "orcamento", id, `${user.name} converteu o orcamento ${q.number} na reserva ${number}`);
  await logAction(user, "criar", "reserva", reservationId, `Reserva ${number} criada a partir do orcamento ${q.number}`);

  revalidatePath("/orcamentos");
  revalidatePath("/reservas");
  redirect(`/reservas/${reservationId}`);
}

export async function deleteQuote(fd: FormData) {
  const user = await assertAdmin();
  const id = Number(fd.get("id"));
  const q = await one<any>(`SELECT number FROM quotes WHERE id = ?`, [id]);
  await run(`DELETE FROM quotes WHERE id = ?`, [id]);
  await logAction(user, "excluir", "orcamento", id, `${user.name} excluiu o orcamento ${q?.number}`);
  redirect("/orcamentos");
}
