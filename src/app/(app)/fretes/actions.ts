"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { insert, nextNumber, one, run } from "@/lib/db";
import { assertAdmin, requireUser } from "@/lib/auth";
import { logAction } from "@/lib/audit";
import { money, parseMoney } from "@/lib/format";
import { setSettings } from "@/lib/settings";

function read(fd: FormData) {
  return {
    customer_id: Number(fd.get("customer_id")) || null,
    contact_name: String(fd.get("contact_name") ?? "").trim(),
    phone: String(fd.get("phone") ?? "").trim(),
    date: String(fd.get("date") ?? "").slice(0, 10),
    time: String(fd.get("time") ?? ""),
    origin: String(fd.get("origin") ?? "").trim(),
    destination: String(fd.get("destination") ?? "").trim(),
    cargo: String(fd.get("cargo") ?? "").trim(),
    amount_cents: parseMoney(String(fd.get("amount") ?? "")),
    method: String(fd.get("method") ?? "pix"),
    status: String(fd.get("status") ?? "orcamento"),
    vehicle_id: Number(fd.get("vehicle_id")) || null,
    notes: String(fd.get("notes") ?? "").trim(),
  };
}

export async function createFreight(_prev: string | null, fd: FormData): Promise<string | null> {
  const user = await requireUser();
  const f = read(fd);
  if (!f.date) return "Informe a data do frete.";
  if (!f.contact_name && !f.customer_id) return "Informe o cliente ou o nome do contato.";

  const number = await nextNumber("freights", "FRT");
  const id = await insert(
    `INSERT INTO freights (number, customer_id, contact_name, phone, date, time, origin, destination, cargo,
      amount_cents, method, status, vehicle_id, notes, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      number,
      f.customer_id,
      f.contact_name,
      f.phone,
      f.date,
      f.time,
      f.origin,
      f.destination,
      f.cargo,
      f.amount_cents,
      f.method,
      f.status,
      f.vehicle_id,
      f.notes,
      user.id,
    ],
  );
  await logAction(user, "criar", "frete", id, `${user.name} criou o frete ${number} (${money(f.amount_cents)})`);
  revalidatePath("/fretes");
  revalidatePath("/agenda");
  redirect(`/fretes/${id}`);
}

export async function updateFreight(_prev: string | null, fd: FormData): Promise<string | null> {
  const user = await requireUser();
  const id = Number(fd.get("id"));
  const f = read(fd);
  const current = await one<any>(`SELECT number FROM freights WHERE id = ?`, [id]);
  if (!current) return "Frete não encontrado.";

  await run(
    `UPDATE freights SET customer_id=?, contact_name=?, phone=?, date=?, time=?, origin=?, destination=?, cargo=?,
            amount_cents=?, method=?, status=?, vehicle_id=?, notes=? WHERE id = ?`,
    [
      f.customer_id,
      f.contact_name,
      f.phone,
      f.date,
      f.time,
      f.origin,
      f.destination,
      f.cargo,
      f.amount_cents,
      f.method,
      f.status,
      f.vehicle_id,
      f.notes,
      id,
    ],
  );
  await logAction(user, "editar", "frete", id, `${user.name} alterou o frete ${current.number}`);
  revalidatePath(`/fretes/${id}`);
  redirect(`/fretes/${id}`);
}

export async function setFreightStatus(fd: FormData) {
  const user = await requireUser();
  const id = Number(fd.get("id"));
  const status = String(fd.get("status"));
  const f = await one<any>(`SELECT * FROM freights WHERE id = ?`, [id]);
  if (!f) return;
  await run(`UPDATE freights SET status = ? WHERE id = ?`, [status, id]);
  await logAction(user, "status", "frete", id, `${user.name} marcou o frete ${f.number} como ${status}`);
  revalidatePath(`/fretes/${id}`);
  revalidatePath("/fretes");
}

export async function payFreight(fd: FormData) {
  const user = await requireUser();
  const id = Number(fd.get("id"));
  const f = await one<any>(`SELECT * FROM freights WHERE id = ?`, [id]);
  if (!f) return;
  const amount = parseMoney(String(fd.get("amount") ?? "")) || f.amount_cents;
  if (amount <= 0) return;
  await insert(
    `INSERT INTO payments (freight_id, amount_cents, method, paid_at, notes, created_by) VALUES (?,?,?,?,?,?)`,
    [id, amount, String(fd.get("method") ?? f.method), String(fd.get("paid_at") ?? ""), `Frete ${f.number}`, user.id],
  );
  await logAction(user, "pagamento", "frete", id, `${user.name} registrou pagamento de ${money(amount)} no frete ${f.number}`);
  revalidatePath(`/fretes/${id}`);
  revalidatePath("/financeiro");
}

export async function deleteFreight(fd: FormData) {
  const user = await assertAdmin();
  const id = Number(fd.get("id"));
  const f = await one<any>(`SELECT number FROM freights WHERE id = ?`, [id]);
  await run(`DELETE FROM freights WHERE id = ?`, [id]);
  await logAction(user, "excluir", "frete", id, `${user.name} excluiu o frete ${f?.number}`);
  redirect("/fretes");
}

/** Guarda o preco do litro usado na calculadora como novo padrao. */
export async function salvarPrecoCombustivel(fd: FormData) {
  const user = await requireUser();
  const cents = parseMoney(String(fd.get("preco") ?? ""));
  if (cents <= 0) return;
  const tipo = fd.get("tipo");
  if (tipo !== "comum" && tipo !== "locacao") return;
  await setSettings({ [`freight_${tipo}_fuel_price_cents`]: String(cents) });
  await logAction(user, "editar", "configuracao", null, `${user.name} atualizou o preco do combustivel para ${money(cents)}/L`);
  revalidatePath("/fretes/calculadora");
  revalidatePath("/configuracoes");
}
