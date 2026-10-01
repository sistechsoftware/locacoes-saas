"use server";
import { revalidatePath } from "next/cache";
import { run } from "@/lib/db";
import { requireUser } from "@/lib/auth";

/**
 * Notificações são POR EMPRESA (notifications.company_id): marcar leitura
 * sempre escopo pela empresa da sessão — nunca por id solto.
 */
export async function markAllRead() {
  const user = await requireUser();
  await run(`UPDATE notifications SET read_at = datetime('now','localtime') WHERE read_at IS NULL AND company_id = ?`, [user.company_id]);
  revalidatePath("/notificacoes");
}

export async function markRead(fd: FormData) {
  const user = await requireUser();
  await run(`UPDATE notifications SET read_at = datetime('now','localtime') WHERE id = ? AND company_id = ?`, [Number(fd.get("id")), user.company_id]);
  revalidatePath("/notificacoes");
}
