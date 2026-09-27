"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { all, insert, one, run } from "@/lib/db";
import { assertAdmin, requireUser } from "@/lib/auth";
import { logAction } from "@/lib/audit";
import { attach, removeAttachment, UploadError } from "@/lib/uploads";
import { parseMoney, nowLocal, today } from "@/lib/format";
import { stamp } from "@/lib/stock";
import { checklistFor } from "@/lib/checklists";
import { completeDamageMaintenance, resolveDamage as resolverDanoCore, revertDamageWriteOff, validarQuantidadeDoDano } from "@/lib/danos";

/* ------------------------------- criar / editar ------------------------------- */

export async function createOperation(_prev: string | null, fd: FormData): Promise<string | null> {
  const user = await requireUser();
  const kind = String(fd.get("kind") ?? "entrega");
  const reservationId = Number(fd.get("reservation_id")) || null;
  const scheduled = stamp(String(fd.get("scheduled_at") ?? ""), "08:00");
  if (!scheduled) return "Informe a data e o horário.";
  if (!reservationId) return "Selecione a reserva.";
  const assigneeId = Number(fd.get("assignee_id")) || null;
  if (assigneeId && !await one("SELECT id FROM users WHERE id=? AND active=1",[assigneeId])) return "Responsável inválido ou inativo.";

  const id = await insert(
    `INSERT INTO operations (kind, reservation_id, scheduled_at, status, assignee, vehicle_id, notes, assignee_id)
     VALUES (?,?,?,?,?,?,?,?)`,
    [
      kind,
      reservationId,
      scheduled,
      String(fd.get("status") ?? "pendente"),
      String(fd.get("assignee") ?? ""),
      Number(fd.get("vehicle_id")) || null,
      String(fd.get("notes") ?? ""),
      assigneeId,
    ],
  );
  const r = await one<any>(`SELECT number FROM reservations WHERE id = ?`, [reservationId]);
  await logAction(user, "criar", "operacao", id, `${user.name} agendou ${kind} de ${r?.number} para ${scheduled}`);
  revalidatePath("/operacao");
  revalidatePath("/agenda");
  redirect(`/operacao/${id}`);
}

export async function updateOperation(fd: FormData) {
  const user = await requireUser();
  const id = Number(fd.get("id"));
  const op = await one<any>(`SELECT * FROM operations WHERE id = ?`, [id]);
  if (!op) return;

  const scheduled = stamp(String(fd.get("scheduled_at") ?? op.scheduled_at), "08:00");
  const assigneeId = Number(fd.get("assignee_id")) || null;
  if (assigneeId && !await one("SELECT id FROM users WHERE id=? AND active=1",[assigneeId])) throw new Error("Responsável inválido ou inativo.");
  await run(
    `UPDATE operations SET scheduled_at = ?, assignee = ?, vehicle_id = ?, notes = ?, assignee_id = ?, updated_at = datetime('now','localtime')
      WHERE id = ?`,
    [scheduled, String(fd.get("assignee") ?? ""), Number(fd.get("vehicle_id")) || null, String(fd.get("notes") ?? ""), assigneeId, id],
  );
  await logAction(user, "editar", "operacao", id, `${user.name} atualizou a ${op.kind} agendada para ${scheduled}`);
  revalidatePath(`/operacao/${id}`);
  revalidatePath("/agenda");
}

export async function setOperationStatus(fd: FormData) {
  const user = await requireUser();
  const id = Number(fd.get("id"));
  const status = String(fd.get("status"));
  const op = await one<any>(
    `SELECT o.*, r.number, r.status AS reservation_status FROM operations o
       LEFT JOIN reservations r ON r.id = o.reservation_id WHERE o.id = ?`,
    [id],
  );
  if (!op) return;

  await run(
    `UPDATE operations SET status = ?, completed_at = CASE WHEN ? = 'concluida' THEN ? ELSE completed_at END,
            updated_at = datetime('now','localtime') WHERE id = ?`,
    [status, status, nowLocal(), id],
  );

  // avanca o status da reserva conforme a operacao e concluida
  if (status === "concluida" && op.reservation_id) {
    if (op.kind === "entrega" && ["confirmada", "pre_reserva"].includes(op.reservation_status)) {
      await run(`UPDATE reservations SET status = 'entregue' WHERE id = ?`, [op.reservation_id]);
    }
    if (op.kind === "retirada" && ["entregue", "em_uso", "aguardando_retirada"].includes(op.reservation_status)) {
      await run(`UPDATE reservations SET status = 'retirada' WHERE id = ?`, [op.reservation_id]);
    }
  }

  await logAction(user, "status", "operacao", id, `${user.name} marcou a ${op.kind} de ${op.number ?? "-"} como ${status}`);
  revalidatePath(`/operacao/${id}`);
  revalidatePath("/operacao");
  revalidatePath("/dashboard");
}

export async function cancelOperation(fd: FormData) {
  const user = await assertAdmin();
  const id = Number(fd.get("id"));
  const op = await one<any>(`SELECT * FROM operations WHERE id = ?`, [id]);
  if (!op) return;
  await run(`UPDATE operations SET status = 'cancelada' WHERE id = ?`, [id]);
  await logAction(user, "cancelar", "operacao", id, `${user.name} cancelou a ${op.kind}`);
  revalidatePath(`/operacao/${id}`);
}

/* --------------------------------- checklist ---------------------------------- */

export async function saveChecklist(fd: FormData) {
  const user = await requireUser();
  const id = Number(fd.get("operation_id"));
  const op = await one<any>(`SELECT * FROM operations WHERE id = ?`, [id]);
  if (!op) return;

  const itens = checklistFor(op.kind);
  const data: Record<string, boolean> = {};
  for (const item of itens) data[item] = fd.get(`chk:${item}`) === "on";
  const notes = String(fd.get("notes") ?? "");

  const existing = await one<any>(`SELECT id FROM checklists WHERE operation_id = ? ORDER BY id DESC LIMIT 1`, [id]);
  if (existing) {
    await run(`UPDATE checklists SET data = ?, notes = ? WHERE id = ?`, [JSON.stringify(data), notes, existing.id]);
  } else {
    await insert(`INSERT INTO checklists (operation_id, kind, data, notes, created_by) VALUES (?,?,?,?,?)`, [
      id,
      op.kind,
      JSON.stringify(data),
      notes,
      user.id,
    ]);
  }

  const files = fd.getAll("photos").filter((f): f is File => f instanceof File);
  if (files.length) {
    try {
      await attach("operacao", id, files, user.id, "Checklist");
    } catch (e) {
      const motivo = e instanceof UploadError ? e.message : "Não foi possível salvar as fotos.";
      redirect(`/operacao/${id}?erro=${encodeURIComponent(motivo)}`);
    }
  }

  await logAction(user, "checklist", "operacao", id, `${user.name} salvou o checklist da ${op.kind}`);
  revalidatePath(`/operacao/${id}`);
}

export async function deletePhoto(fd: FormData) {
  const user = await requireUser();
  const attachmentId = Number(fd.get("attachment_id"));
  const operationId = Number(fd.get("operation_id"));
  await removeAttachment(attachmentId);
  await logAction(user, "excluir", "operacao", operationId, `${user.name} removeu uma foto`);
  revalidatePath(`/operacao/${operationId}`);
}

/* ----------------------------------- danos ------------------------------------ */

export async function reportDamage(fd: FormData) {
  const user = await requireUser();
  const operationId = Number(fd.get("operation_id"));
  const reservationId = Number(fd.get("reservation_id"));
  const productId = Number(fd.get("product_id")) || null;
  const qty = Math.max(1, Number(fd.get("qty")) || 1);
  const estimated = parseMoney(String(fd.get("estimated") ?? ""));
  const charged = parseMoney(String(fd.get("charged") ?? ""));

  // a baixa posterior respeita o que a reserva contratou: nao faz sentido
  // registrar mais unidades quebradas do que foram entregues
  if (productId && reservationId) {
    const invalido = await validarQuantidadeDoDano(reservationId, productId, qty);
    if (invalido) redirect(`/operacao/${operationId}?erro=${encodeURIComponent(invalido)}`);
  }

  const file = fd.get("photo");
  let photo: string | null = null;
  if (file instanceof File && file.size > 0) {
    try {
      photo = await attachOne(file, user.id, reservationId);
    } catch (e) {
      const motivo = e instanceof UploadError ? e.message : "Não foi possível salvar a foto do dano.";
      redirect(`/operacao/${operationId}?erro=${encodeURIComponent(motivo)}`);
    }
  }

  const id = await insert(
    `INSERT INTO damage_reports (reservation_id, product_id, qty, damage_type, description, photo, estimated_cents, charged_cents, created_by)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [
      reservationId,
      productId,
      qty,
      String(fd.get("damage_type") ?? ""),
      String(fd.get("description") ?? ""),
      photo,
      estimated,
      charged,
      user.id,
    ],
  );

  // desconta da caucao quando houver valor cobrado
  if (charged > 0) {
    const dep = await one<any>(`SELECT * FROM deposits WHERE reservation_id = ? ORDER BY id DESC LIMIT 1`, [reservationId]);
    if (dep) {
      const retido = Math.min(dep.amount_cents, dep.retained_cents + charged);
      await run(`UPDATE deposits SET retained_cents = ?, status = ?, reason = COALESCE(NULLIF(reason,''),?) WHERE id = ?`, [
        retido,
        retido >= dep.amount_cents ? "retida_integral" : "retida_parcial",
        String(fd.get("description") ?? "Dano registrado na retirada"),
        dep.id,
      ]);
    }
  }

  await logAction(user, "dano", "reserva", reservationId, `${user.name} registrou dano em ${qty} item(ns)`, { damage: id });
  revalidatePath(`/operacao/${operationId}`);
  revalidatePath(`/reservas/${reservationId}`);
}

/* ----------------------------- resolver dano --------------------------------- */

function voltaDoDano(operationId: number | null, reservationId: number | null) {
  return operationId ? `/operacao/${operationId}` : reservationId ? `/reservas/${reservationId}` : "/operacao";
}

/**
 * Resolve um dano registrado: baixa definitiva (sai de total_qty com
 * movimentacao no livro) ou envio para manutencao (maintenance_qty).
 * O estoque so muda aqui, nunca no registro do dano.
 */
export async function resolverDano(fd: FormData) {
  const user = await requireUser();
  const damageId = Number(fd.get("damage_id"));
  const action = String(fd.get("action") ?? "") === "manutencao" ? "manutencao" : "baixa";
  const operationId = Number(fd.get("operation_id")) || null;
  const reservationId = Number(fd.get("reservation_id")) || null;
  const notes = String(fd.get("notes") ?? "").trim();
  const volta = voltaDoDano(operationId, reservationId);

  const resultado = await resolverDanoCore(user, damageId, action, { notes });
  if (!resultado.ok) redirect(`${volta}?erro=${encodeURIComponent(resultado.erro)}`);

  revalidatePath("/", "layout");
  redirect(volta);
}

/** Conclui a manutencao aberta a partir de um dano: o item volta ao disponivel. */
export async function consertarDano(fd: FormData) {
  const user = await requireUser();
  const damageId = Number(fd.get("damage_id"));
  const operationId = Number(fd.get("operation_id")) || null;
  const reservationId = Number(fd.get("reservation_id")) || null;
  const volta = voltaDoDano(operationId, reservationId);

  const resultado = await completeDamageMaintenance(user, damageId);
  if (!resultado.ok) redirect(`${volta}?erro=${encodeURIComponent(resultado.erro)}`);

  revalidatePath("/", "layout");
  redirect(volta);
}

/** Estorna uma baixa definitiva: devolve as unidades por movimentacao inversa. */
export async function estornarBaixaDano(fd: FormData) {
  const user = await requireUser();
  const damageId = Number(fd.get("damage_id"));
  const operationId = Number(fd.get("operation_id")) || null;
  const reservationId = Number(fd.get("reservation_id")) || null;
  const motivo = String(fd.get("motivo") ?? "").trim();
  const volta = voltaDoDano(operationId, reservationId);

  const resultado = await revertDamageWriteOff(user, damageId, motivo);
  if (!resultado.ok) redirect(`${volta}?erro=${encodeURIComponent(resultado.erro)}`);

  revalidatePath("/", "layout");
  redirect(volta);
}

async function attachOne(file: File, userId: number, reservationId: number) {
  const saved = await attach("dano", reservationId, [file], userId, "Dano");
  if (!saved) return null;
  const a = await one<any>(`SELECT path FROM attachments WHERE entity = 'dano' AND entity_id = ? ORDER BY id DESC LIMIT 1`, [
    reservationId,
  ]);
  return a?.path ?? null;
}

/* ---------------------------------- veiculos ---------------------------------- */

export async function saveVehicle(fd: FormData) {
  const user = await requireUser();
  const id = Number(fd.get("id")) || null;
  const values = [
    String(fd.get("name") ?? "").trim(),
    String(fd.get("plate") ?? "").trim().toUpperCase(),
    String(fd.get("model") ?? "").trim(),
    String(fd.get("capacity") ?? "").trim(),
    String(fd.get("notes") ?? "").trim(),
  ];
  if (!values[0]) return;
  if (id) {
    await run(`UPDATE vehicles SET name=?, plate=?, model=?, capacity=?, notes=? WHERE id = ?`, [...values, id]);
    await logAction(user, "editar", "veiculo", id, `${user.name} alterou o veiculo ${values[0]}`);
  } else {
    const newId = await insert(`INSERT INTO vehicles (name, plate, model, capacity, notes) VALUES (?,?,?,?,?)`, values);
    await logAction(user, "criar", "veiculo", newId, `${user.name} cadastrou o veiculo ${values[0]}`);
  }
  revalidatePath("/configuracoes");
  revalidatePath("/fretes");
}

export async function deleteVehicle(fd: FormData) {
  const user = await assertAdmin();
  const id = Number(fd.get("id"));
  const v = await one<any>(`SELECT name FROM vehicles WHERE id = ?`, [id]);
  await run(`UPDATE operations SET vehicle_id = NULL WHERE vehicle_id = ?`, [id]);
  await run(`UPDATE freights SET vehicle_id = NULL WHERE vehicle_id = ?`, [id]);
  await run(`DELETE FROM vehicles WHERE id = ?`, [id]);
  await logAction(user, "excluir", "veiculo", id, `${user.name} removeu o veiculo ${v?.name}`);
  revalidatePath("/configuracoes");
}
