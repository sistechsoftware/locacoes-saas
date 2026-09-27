"use server";
import { windowError } from "@/lib/availability-time";
import { stockVersion, writeRental, commitStockBatch, STOCK_CHANGED } from "@/lib/stock-write";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { all, insert, one, run, scalar } from "@/lib/db";
import { assertAdmin, currentUser, requireUser } from "@/lib/auth";
import { logAction } from "@/lib/audit";
import { removeAttachment } from "@/lib/uploads";
import { recalcReservation, reservationMoney, syncOperations, getReservation } from "@/lib/reservations";
import {
  checkConflicts,
  checkReservationConflicts,
  conflictsMessage,
  holdWindow,
  rebuildReservationComponents,
  stamp,
} from "@/lib/stock";
import { aoConcluirLocacao, devolverRecompensaDaReserva, reverterReserva } from "@/lib/fidelidade-db";
import { criarAdiantamento } from "@/lib/receber";
import { HOLDING_STATUSES } from "@/lib/domain";
import { money, parseMoney, today } from "@/lib/format";

export type ItemInput = { product_id: number; qty: number; unit_price_cents: number; discount_cents: number };

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
    needs_delivery: fd.get("needs_delivery") ? 1 : 0,
    needs_pickup: fd.get("needs_pickup") ? 1 : 0,
    needs_assembly: fd.get("needs_assembly") ? 1 : 0,
    needs_disassembly: fd.get("needs_disassembly") ? 1 : 0,
    freight_cents: parseMoney(String(fd.get("freight") ?? "")),
    assembly_cents: parseMoney(String(fd.get("assembly") ?? "")),
    disassembly_cents: parseMoney(String(fd.get("disassembly") ?? "")),
    other_cents: parseMoney(String(fd.get("other") ?? "")),
    discount_cents: parseMoney(String(fd.get("discount") ?? "")),
    notes: String(fd.get("notes") ?? "").trim(),
    status: String(fd.get("status") ?? "pre_reserva"),
    deposit_cents: parseMoney(String(fd.get("deposit") ?? "")),
  };
}

const conflictMessage = conflictsMessage;


/* ------------------------------------------------------------------ */
/* Criacao                                                             */
/* ------------------------------------------------------------------ */

export async function createReservation(_prev: string | null, fd: FormData): Promise<string | null> {
  const user = await requireUser();
  const version = await stockVersion();
  let h: ReturnType<typeof readHeader>;
  try { h = readHeader(fd); } catch (e) { return (e as Error).message; }
  const options = { considerPreparation: fd.get("consider_preparation") !== "0" };
  const items = readItems(fd);
  const override = fd.get("override") === "1" && user.role === "admin";
  if (!h.customer_id) return "Selecione o cliente.";
  if (!h.event_date) return "Informe a data do evento.";
  if (!items.length) return "Adicione ao menos um item a reserva.";
  const invalid = windowError(h.delivery_at, h.pickup_at);
  if (invalid) return invalid;
  if ((HOLDING_STATUSES as readonly string[]).includes(h.status)) {
    const conflicts = await checkConflicts(items, h.delivery_at, h.pickup_at, null, options);
    if (conflicts.length && !override) return conflictMessage(conflicts);
  }
  let saved: { id: number; number: string };
  try {
    saved = await writeRental(version, { ...h, stock_override: override ? 1 : 0,
      stock_consider_preparation: options.considerPreparation ? 1 : 0, created_by: user.id }, items);
  } catch (e) { if ((e as Error).message === STOCK_CHANGED) return STOCK_CHANGED; throw e; }
  const { id, number } = saved;
  await insert("INSERT INTO deposits (reservation_id, amount_cents, status) VALUES (?,?,'nao_recebida')", [id, h.deposit_cents]);
  await recalcReservation(id);
  await syncOperations(id);
  await logAction(user, "criar", "reserva", id, `${user.name} criou a reserva ${number}`, { items: items.length });

  // adiantamento e opcional na criacao: a reserva ja esta gravada quando isto
  // roda, entao um valor invalido aqui nunca pode custar a reserva inteira —
  // so avisa, e o adiantamento continua disponivel para lancar na tela dela
  let avisoAdiantamento: string | null = null;
  if (fd.get("advance_has") === "1") {
    avisoAdiantamento = await criarAdiantamento({
      reservationId: id,
      amountCents: parseMoney(String(fd.get("advance_amount") ?? "")),
      imediato: String(fd.get("advance_type") ?? "agendado") === "agora",
      dataPrevista: String(fd.get("advance_date") ?? "") || today(),
      method: String(fd.get("advance_method") ?? "pix"),
      accountId: Number(fd.get("advance_account_id")) || null,
      userId: user.id,
    });
  }

  revalidatePath("/", "layout");
  redirect(`/reservas/${id}${avisoAdiantamento ? `?aviso=${encodeURIComponent(avisoAdiantamento)}` : ""}`);
}

export async function updateReservation(_prev: string | null, fd: FormData): Promise<string | null> {
  const user = await requireUser();
  const version = await stockVersion();
  const id = Number(fd.get("id"));
  const current = await one<any>("SELECT * FROM reservations WHERE id=?", [id]);
  if (!current) return "Reserva não encontrada.";
  let h: ReturnType<typeof readHeader>;
  try { h = readHeader(fd); } catch (e) { return (e as Error).message; }
  const items = readItems(fd);
  const options = { considerPreparation: fd.get("consider_preparation") !== "0" };
  const override = fd.get("override") === "1" && user.role === "admin";
  if (!h.customer_id) return "Selecione o cliente.";
  if (!items.length) return "A reserva precisa ter ao menos um item.";
  const invalid = windowError(h.delivery_at, h.pickup_at);
  if (invalid) return invalid;
  if ((HOLDING_STATUSES as readonly string[]).includes(h.status)) {
    const conflicts = await checkConflicts(items, h.delivery_at, h.pickup_at, id, options);
    if (conflicts.length && !override) return conflictMessage(conflicts);
  }
  try {
    await writeRental(version, { ...h, stock_override: override ? 1 : current.stock_override,
      stock_consider_preparation: options.considerPreparation ? 1 : 0 }, items, id);
  } catch (e) { if ((e as Error).message === STOCK_CHANGED) return STOCK_CHANGED; throw e; }
  const dep = await one<any>("SELECT id FROM deposits WHERE reservation_id=? ORDER BY id DESC LIMIT 1", [id]);
  if (dep) await run("UPDATE deposits SET amount_cents=? WHERE id=?", [h.deposit_cents,dep.id]);
  else await insert("INSERT INTO deposits(reservation_id,amount_cents,status) VALUES(?,?,'nao_recebida')", [id,h.deposit_cents]);
  await recalcReservation(id);
  await syncOperations(id);
  await logAction(user, "editar", "reserva", id, `${user.name} alterou a reserva ${current.number}`);
  revalidatePath("/", "layout");
  redirect(`/reservas/${id}`);
}

/* ------------------------------------------------------------------ */
/* Status                                                              */
/* ------------------------------------------------------------------ */

export async function changeStatus(fd: FormData) {
  const user = await requireUser();
  const version = await stockVersion();
  const id = Number(fd.get("id"));
  const status = String(fd.get("status"));
  const r = await one<any>(`SELECT * FROM reservations WHERE id = ?`, [id]);
  if (!r) return;

  if (status === "cancelada" && user.role !== "admin") {
    redirect(`/reservas/${id}?erro=${encodeURIComponent("Somente o administrador pode cancelar reservas.")}`);
  }

  // ao voltar a ocupar estoque, revalida disponibilidade
  if ((HOLDING_STATUSES as readonly string[]).includes(status) && !(HOLDING_STATUSES as readonly string[]).includes(r.status)) {
    const conflicts = await checkReservationConflicts(id, { considerPreparation: fd.has("consider_preparation") ? fd.get("consider_preparation") !== "0" : r.stock_consider_preparation !== 0 });
    if (conflicts.length && !r.stock_override) {
      redirect(`/reservas/${id}?erro=${encodeURIComponent(conflictMessage(conflicts))}`);
    }
  }

  try {
    await commitStockBatch(version, [{ sql: `UPDATE reservations SET status = ?, updated_at = datetime('now','localtime') WHERE id = ?`, params: [status,id] }]);
  } catch (e) {
    if ((e as Error).message === STOCK_CHANGED) redirect(`/reservas/${id}?erro=${encodeURIComponent(STOCK_CHANGED)}`);
    throw e;
  }
  if (status === "cancelada") {
    await run(`UPDATE reservations SET cancel_reason = ? WHERE id = ?`, [String(fd.get("reason") ?? ""), id]);
  }
  // cancelar libera o estoque automaticamente: a reserva deixa de ocupar a
  // janela, e a expansao fisica deixa de ser contabilizada pelo motor.
  await syncOperations(id);

  // fidelidade acompanha o status real da locacao, nunca uma tela aberta
  if (status === "cancelada") {
    await reverterReserva(id, user.id);
    await devolverRecompensaDaReserva(id);
  } else {
    await aoConcluirLocacao(id, user.id);
  }

  await logAction(user, "status", "reserva", id, `${user.name} alterou o status da reserva ${r.number} para ${status}`);
  revalidatePath(`/reservas/${id}`);
  revalidatePath("/dashboard");
  revalidatePath(`/clientes/${r.customer_id}`);
}

/* ------------------------------------------------------------------ */
/* Pagamentos e caucao                                                 */
/* ------------------------------------------------------------------ */

export async function addPayment(fd: FormData) {
  const user = await requireUser();
  const id = Number(fd.get("reservation_id"));
  const amount = parseMoney(String(fd.get("amount") ?? ""));
  if (amount <= 0) redirect(`/reservas/${id}?erro=${encodeURIComponent("Informe um valor válido.")}`);

  const r = await one<any>(`SELECT number FROM reservations WHERE id = ?`, [id]);
  // a conta corrente acompanha o dinheiro na origem: sem ela o lancamento entra
  // no caixa de ninguem e o saldo da conta nao fecha com o extrato
  await insert(
    `INSERT INTO payments (reservation_id, amount_cents, method, paid_at, notes, account_id, created_by) VALUES (?,?,?,?,?,?,?)`,
    [
      id,
      amount,
      String(fd.get("method") ?? "pix"),
      String(fd.get("paid_at") ?? "") || today(),
      String(fd.get("notes") ?? ""),
      Number(fd.get("account_id")) || null,
      user.id,
    ],
  );
  await logAction(user, "pagamento", "reserva", id, `${user.name} registrou pagamento de ${money(amount)} na reserva ${r?.number}`);
  revalidatePath(`/reservas/${id}`);
  revalidatePath("/financeiro");
}

export async function deletePayment(fd: FormData) {
  const user = await assertAdmin();
  const paymentId = Number(fd.get("payment_id"));
  const p = await one<any>(`SELECT * FROM payments WHERE id = ?`, [paymentId]);
  if (!p) return;
  await run(`DELETE FROM payments WHERE id = ?`, [paymentId]);
  await logAction(user, "excluir", "reserva", p.reservation_id, `${user.name} removeu um pagamento de ${money(p.amount_cents)}`);
  revalidatePath(`/reservas/${p.reservation_id}`);
}

export async function saveDeposit(fd: FormData) {
  const user = await requireUser();
  const id = Number(fd.get("reservation_id"));
  const amount = parseMoney(String(fd.get("amount") ?? ""));
  const status = String(fd.get("status") ?? "nao_recebida");
  const retained = parseMoney(String(fd.get("retained") ?? ""));
  const dep = await one<any>(`SELECT id FROM deposits WHERE reservation_id = ? ORDER BY id DESC LIMIT 1`, [id]);

  const values = [
    amount,
    String(fd.get("method") ?? ""),
    String(fd.get("received_at") ?? "") || null,
    String(fd.get("returned_at") ?? "") || null,
    status,
    status === "retida_integral" ? amount : retained,
    String(fd.get("reason") ?? ""),
  ];

  if (dep) {
    await run(
      `UPDATE deposits SET amount_cents=?, method=?, received_at=?, returned_at=?, status=?, retained_cents=?, reason=?
        WHERE id = ?`,
      [...values, dep.id],
    );
  } else {
    await insert(
      `INSERT INTO deposits (amount_cents, method, received_at, returned_at, status, retained_cents, reason, reservation_id)
       VALUES (?,?,?,?,?,?,?,?)`,
      [...values, id],
    );
  }
  await logAction(user, "caucao", "reserva", id, `${user.name} atualizou a caucao (${status})`);
  revalidatePath(`/reservas/${id}`);
}

/* ------------------------------------------------------------------ */
/* Exclusao                                                            */
/* ------------------------------------------------------------------ */

export async function deleteReservation(fd: FormData) {
  const user = await assertAdmin();
  const id = Number(fd.get("id"));
  const r = await one<any>(`SELECT number FROM reservations WHERE id = ?`, [id]);
  if (!r) redirect("/reservas");

  // O orcamento de origem aponta para a reserva sem ON DELETE CASCADE, entao
  // esse vinculo precisa ser desfeito antes, senao a chave estrangeira barra a
  // exclusao. O orcamento em si e preservado e volta a ficar como aprovado.
  const origem = await all<any>(`SELECT id, number FROM quotes WHERE reservation_id = ?`, [id]);
  for (const q of origem) {
    await run(`UPDATE quotes SET reservation_id = NULL, status = 'aprovado' WHERE id = ?`, [q.id]);
  }

  // anexos sao polimorficos (sem chave estrangeira), logo nao caem no cascade
  const anexos = await all<any>(
    `SELECT id FROM attachments WHERE entity = 'operacao' AND entity_id IN (SELECT id FROM operations WHERE reservation_id = ?)`,
    [id],
  );
  for (const a of anexos) await removeAttachment(a.id);
  const anexosDano = await all<any>(`SELECT id FROM attachments WHERE entity = 'dano' AND entity_id = ?`, [id]);
  for (const a of anexosDano) await removeAttachment(a.id);

  await run(`DELETE FROM reservations WHERE id = ?`, [id]);
  await logAction(
    user,
    "excluir",
    "reserva",
    id,
    `${user.name} excluiu definitivamente a reserva ${r.number}` +
      (origem.length ? ` (orcamento ${origem.map((q) => q.number).join(", ")} voltou para aprovado)` : ""),
  );

  revalidatePath("/reservas");
  revalidatePath("/orcamentos");
  redirect("/reservas");
}

/* ------------------------------------------------------------------ */
/* Consulta de disponibilidade usada pelo formulario                   */
/* ------------------------------------------------------------------ */

export async function checkStock(payload: {
  items: ItemInput[];
  from: string;
  to: string;
  excludeId?: number | null;
  considerPreparation?: boolean;
}) {
  await requireUser();
  const conflicts = await checkConflicts(payload.items, payload.from, payload.to, payload.excludeId ?? null, { considerPreparation: payload.considerPreparation !== false });
  return conflicts.map((c) => ({
    product_id: c.product_id,
    product: c.product,
    kind: c.kind,
    requested: c.requested,
    available: c.available,
    missing: c.missing,
    components: c.components,
    holds: c.holds.map((h) => ({ number: h.number, customer: h.customer, qty: h.qty, hold_start: h.hold_start, hold_end: h.hold_end })),
  }));
}

/** Envia mensagem de WhatsApp: apenas registra no historico (o link abre no cliente). */
export async function logWhatsApp(fd: FormData) {
  const user = await currentUser();
  const id = Number(fd.get("reservation_id"));
  const kind = String(fd.get("kind") ?? "mensagem");
  await logAction(user, "whatsapp", "reserva", id, `${user?.name} enviou mensagem de ${kind} pelo WhatsApp`);
  revalidatePath(`/reservas/${id}`);
}

/**
 * Regrava a expansao fisica desta reserva usando a composicao atual dos kits.
 *
 * Serve para o caso em que o kit foi cadastrado incompleto e corrigido depois:
 * a reserva antiga continua com o consumo antigo ate que alguem confirme a
 * atualizacao aqui. Nada mais da reserva muda: quantidades, precos e total
 * continuam como estao.
 */
export async function refreshComposition(fd: FormData) {
  const user = await requireUser();
  const version = await stockVersion();
  const id = Number(fd.get("id"));
  const r = await one<any>(`SELECT * FROM reservations WHERE id = ?`, [id]);
  if (!r) return;

  if ((HOLDING_STATUSES as readonly string[]).includes(r.status)) {
    const items = await all<any>(`SELECT product_id, qty FROM reservation_items WHERE reservation_id = ?`, [id]);
    const w = holdWindow(r);
    const conflicts = await checkConflicts(items, w.from, w.to, id, { considerPreparation: fd.has("consider_preparation") ? fd.get("consider_preparation") !== "0" : r.stock_consider_preparation !== 0 });
    if (conflicts.length && !r.stock_override) redirect(`/reservas/${id}?erro=${encodeURIComponent(conflictsMessage(conflicts))}`);
  }

  try { await rebuildReservationComponents(id, version); }
  catch (e) {
    if ((e as Error).message === STOCK_CHANGED) redirect(`/reservas/${id}?erro=${encodeURIComponent(STOCK_CHANGED)}`);
    throw e;
  }
  await logAction(
    user,
    "editar",
    "reserva",
    id,
    `${user.name} atualizou a composicao dos kits da reserva ${r.number}`,
  );
  revalidatePath(`/reservas/${id}`);
  revalidatePath("/disponibilidade");
  revalidatePath("/dashboard");
}
