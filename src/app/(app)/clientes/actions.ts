"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getDb, insert, one, run, scalar } from "@/lib/db";
import { assertAdmin, requireUser } from "@/lib/auth";
import { logAction } from "@/lib/audit";
import { validarDocumento } from "@/lib/assinatura";
import { valida } from "@/lib/aniversarios";

function readCustomer(fd: FormData) {
  return {
    name: String(fd.get("name") ?? "").trim(),
    doc: String(fd.get("doc") ?? "").trim(),
    phone: String(fd.get("phone") ?? "").trim(),
    whatsapp: String(fd.get("whatsapp") ?? "").trim(),
    email: String(fd.get("email") ?? "").trim(),
    address: String(fd.get("address") ?? "").trim(),
    district: String(fd.get("district") ?? "").trim(),
    city: String(fd.get("city") ?? "").trim(),
    zip: String(fd.get("zip") ?? "").trim(),
    // data vazia vira null, para o cliente sem nascimento cadastrado nao virar
    // uma data invalida no banco
    birth_date: String(fd.get("birth_date") ?? "").trim() || null,
    notes: String(fd.get("notes") ?? "").trim(),
  };
}

export async function createCustomer(_prev: string | null, fd: FormData): Promise<string | null> {
  const user = await requireUser();
  const c = readCustomer(fd);
  if (!c.name) return "Informe o nome do cliente.";
  if (c.birth_date && !valida(c.birth_date)) return "Data de nascimento inválida.";

  const id = await insert(
    `INSERT INTO customers (name, doc, phone, whatsapp, email, address, district, city, zip, birth_date, notes)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [c.name, c.doc, c.phone, c.whatsapp || c.phone, c.email, c.address, c.district, c.city, c.zip, c.birth_date, c.notes],
  );
  await logAction(user, "criar", "cliente", id, `${user.name} cadastrou o cliente ${c.name}`);
  revalidatePath("/clientes");

  const next = String(fd.get("next") ?? "");
  redirect(next === "reserva" ? `/reservas/nova?cliente=${id}` : `/clientes/${id}`);
}

export async function updateCustomer(_prev: string | null, fd: FormData): Promise<string | null> {
  const user = await requireUser();
  const id = Number(fd.get("id"));
  const c = readCustomer(fd);
  if (!c.name) return "Informe o nome do cliente.";
  if (c.birth_date && !valida(c.birth_date)) return "Data de nascimento inválida.";

  await run(
    `UPDATE customers SET name=?, doc=?, phone=?, whatsapp=?, email=?, address=?, district=?, city=?, zip=?,
            birth_date=?, notes=?, updated_at = datetime('now','localtime')
      WHERE id = ?`,
    [c.name, c.doc, c.phone, c.whatsapp || c.phone, c.email, c.address, c.district, c.city, c.zip, c.birth_date, c.notes, id],
  );
  await logAction(user, "editar", "cliente", id, `${user.name} alterou o cliente ${c.name}`);
  revalidatePath(`/clientes/${id}`);
  redirect(`/clientes/${id}`);
}

/** Inativacao logica: preserva o historico de locacoes do cliente. */
export async function toggleCustomer(fd: FormData) {
  const user = await assertAdmin();
  const id = Number(fd.get("id"));
  const c = await one<any>(`SELECT * FROM customers WHERE id = ?`, [id]);
  if (!c) return;
  const active = c.active ? 0 : 1;
  await run(`UPDATE customers SET active = ? WHERE id = ?`, [active, id]);
  await logAction(user, active ? "reativar" : "inativar", "cliente", id, `${user.name} ${active ? "reativou" : "inativou"} o cliente ${c.name}`);
  revalidatePath(`/clientes/${id}`);
}

/** Exclusao definitiva, permitida apenas quando o cliente nao tem historico. */
export async function deleteCustomer(fd: FormData) {
  const user = await assertAdmin();
  const id = Number(fd.get("id"));
  const usados = await scalar<number>(
    `SELECT (SELECT COUNT(*) FROM reservations WHERE customer_id = ?) + (SELECT COUNT(*) FROM quotes WHERE customer_id = ?)`,
    [id, id],
  );
  const c = await one<any>(`SELECT name FROM customers WHERE id = ?`, [id]);
  if (usados > 0) {
    await run(`UPDATE customers SET active = 0 WHERE id = ?`, [id]);
    await logAction(user, "inativar", "cliente", id, `${user.name} inativou o cliente ${c?.name} (possui historico)`);
    redirect(`/clientes/${id}?aviso=inativado`);
  }
  await run(`DELETE FROM customers WHERE id = ?`, [id]);
  await logAction(user, "excluir", "cliente", id, `${user.name} excluiu o cliente ${c?.name}`);
  redirect("/clientes");
}

/* ------------------------------------------------------------------ */
/* Historico documental                                                */
/* ------------------------------------------------------------------ */

/**
 * Anexa um contrato assinado no papel, ou um documento antigo.
 *
 * Cada envio e um registro proprio: nada substitui o documento anterior,
 * porque um cliente acumula contratos ao longo dos anos.
 */
export async function adicionarDocumento(fd: FormData) {
  const user = await requireUser();
  const customerId = Number(fd.get("customer_id"));
  const arquivo = fd.get("file");
  const voltar = `/clientes/${customerId}`;

  if (!(arquivo instanceof File) || arquivo.size === 0) {
    redirect(`${voltar}?aviso=${encodeURIComponent("Escolha um arquivo para enviar.")}`);
  }
  const erro = validarDocumento(arquivo.type || "", arquivo.size);
  if (erro) redirect(`${voltar}?aviso=${encodeURIComponent(erro)}`);

  const id = crypto.randomUUID().replace(/-/g, "");
  const bytes = new Uint8Array(await arquivo.arrayBuffer());
  await getDb()
    .prepare(`INSERT INTO files (id, mime, size, data, created_by) VALUES (?,?,?,?,?)`)
    .bind(id, arquivo.type.toLowerCase(), bytes.length, bytes, user.id)
    .run();

  await insert(
    `INSERT INTO customer_documents (customer_id, contract_id, title, source, file_id, mime, size, notes, created_by)
     VALUES (?,?,?, 'upload_manual', ?,?,?,?,?)`,
    [
      customerId,
      Number(fd.get("contract_id")) || null,
      String(fd.get("title") ?? "").trim().slice(0, 160) || arquivo.name.slice(0, 160),
      id,
      arquivo.type.toLowerCase(),
      bytes.length,
      String(fd.get("notes") ?? "").trim().slice(0, 300) || null,
      user.id,
    ],
  );

  await logAction(user, "criar", "cliente", customerId, `${user.name} anexou um documento ao cliente`);
  revalidatePath(voltar);
}

/** Remove um documento anexado, deixando rastro na auditoria. */
export async function removerDocumento(fd: FormData) {
  const user = await assertAdmin();
  const id = Number(fd.get("id"));
  const doc = await one<any>(`SELECT * FROM customer_documents WHERE id = ?`, [id]);
  if (!doc) return;
  // documento de assinatura virtual e prova: nao se apaga pela tela
  if (doc.source === "assinatura_virtual") {
    redirect(
      `/clientes/${doc.customer_id}?aviso=${encodeURIComponent(
        "Documento de assinatura virtual não pode ser excluído: ele é a prova do contrato assinado.",
      )}`,
    );
  }
  await run(`DELETE FROM customer_documents WHERE id = ?`, [id]);
  if (doc.file_id) await run(`DELETE FROM files WHERE id = ?`, [doc.file_id]);
  await logAction(user, "excluir", "cliente", doc.customer_id, `${user.name} removeu o documento "${doc.title}"`);
  revalidatePath(`/clientes/${doc.customer_id}`);
}
