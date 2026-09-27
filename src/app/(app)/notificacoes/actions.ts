"use server";
import { revalidatePath } from "next/cache";
import { run } from "@/lib/db";
import { requireUser } from "@/lib/auth";

export async function markAllRead() {
  await requireUser();
  await run(`UPDATE notifications SET read_at = datetime('now','localtime') WHERE read_at IS NULL`);
  revalidatePath("/notificacoes");
}

export async function markRead(fd: FormData) {
  await requireUser();
  await run(`UPDATE notifications SET read_at = datetime('now','localtime') WHERE id = ?`, [Number(fd.get("id"))]);
  revalidatePath("/notificacoes");
}
