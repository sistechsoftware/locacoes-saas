"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { run } from "@/lib/db";
import { requireModuleEdit, requireUser } from "@/lib/auth";
import { reprocessarEmail } from "@/lib/email-queue";
import { logAction } from "@/lib/audit";

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

/**
 * Reprocessa UMA notificação em falha (histórico de e-mails).
 *
 * Permissão = escrita no módulo Notificações (matriz de papéis). A regra de
 * elegibilidade mora em lib/email-queue: só `falha_temporaria` e
 * `falha_definitiva` voltam para a fila — enviado, cancelado e ignorado nunca
 * são reenviados às cegas. A ação fica registrada na auditoria com o id.
 */
export async function reprocessarEmailAction(fd: FormData) {
  const { user, companyId } = await requireModuleEdit("notificacoes");
  const id = Number(fd.get("id"));
  const r = await reprocessarEmail(companyId, id);
  if (!r.ok) {
    redirect(`/notificacoes/emails?erro=${encodeURIComponent(r.erro ?? "Não foi possível reprocessar.")}`);
  }
  await logAction(user, "editar", "notificacao", id, `${user.name} reprocessou um e-mail com falha`);
  revalidatePath("/notificacoes/emails");
}
