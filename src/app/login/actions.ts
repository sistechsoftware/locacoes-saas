"use server";
import { redirect } from "next/navigation";
import { one } from "@/lib/db";
import { createSession, destroySession, verifyPassword } from "@/lib/auth";
import { logAction } from "@/lib/audit";

export async function loginAction(_prev: string | null, formData: FormData): Promise<string | null> {
  const username = String(formData.get("username") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  if (!username || !password) return "Informe usuário e senha.";

  const user = await one<any>(`SELECT * FROM users WHERE lower(username) = ?`, [username]);
  if (!user || !user.active || !verifyPassword(password, user.password_hash)) {
    return "Usuário ou senha inválidos.";
  }
  await createSession(user.id);
  await logAction({ id: user.id, name: user.name, username: user.username, role: user.role, avatar_url: user.avatar_url ?? null }, "login", "usuario", user.id, `${user.name} entrou no sistema`);
  redirect("/dashboard");
}

export async function logoutAction() {
  await destroySession();
  redirect("/login");
}
