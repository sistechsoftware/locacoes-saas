"use server";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { one } from "@/lib/db";
import { createSession, destroySession, verifyPassword, destinoAposLogin } from "@/lib/auth";
import { logAction } from "@/lib/audit";
import { rateLimit } from "@/lib/rate-limit";

/** Proteção anti-força-bruta: limites moderados, sem lockout permanente. */
const IP_LIMIT = 20; // tentativas por IP na janela
const USER_LIMIT = 8; // tentativas por username na janela
const WINDOW_SECONDS = 300; // 5 minutos

async function ipDaRequisicao(): Promise<string> {
  try {
    const h = await headers();
    return h.get("cf-connecting-ip") || h.get("x-forwarded-for")?.split(",")[0]?.trim() || "desconhecido";
  } catch {
    return "desconhecido";
  }
}

export async function loginAction(_prev: string | null, formData: FormData): Promise<string | null> {
  const username = String(formData.get("username") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  if (!username || !password) return "Informe usuário e senha.";

  // Rate limit ANTES de tocar no usuário: a mensagem é genérica para não
  // revelar se o usuário existe. Falha do limitador não bloqueia o login.
  let permitido = true;
  try {
    const ip = await ipDaRequisicao();
    permitido =
      (await rateLimit(`login:ip:${ip}`, IP_LIMIT, WINDOW_SECONDS)) &&
      (await rateLimit(`login:user:${username}`, USER_LIMIT, WINDOW_SECONDS));
  } catch {
    permitido = true;
  }
  if (!permitido) return "Muitas tentativas. Aguarde alguns minutos e tente novamente.";

  const user = await one<any>(`SELECT * FROM users WHERE lower(username) = ?`, [username]);
  if (!user || !user.active || !verifyPassword(password, user.password_hash)) {
    return "Usuário ou senha inválidos.";
  }
  await createSession(user.id);
  await logAction({ id: user.id, name: user.name, username: user.username, role: user.role, company_id: user.company_id, avatar_url: user.avatar_url ?? null, platform_admin: !!user.platform_admin }, "login", "usuario", user.id, `${user.name} entrou no sistema`);
  // Administrador da plataforma entra no ambiente SaaS; cliente/locador no
  // dashboard operacional — destino decidido pelo perfil na SESSÃO (server).
  redirect(destinoAposLogin({ platform_admin: !!user.platform_admin }));
}

export async function logoutAction() {
  await destroySession();
  redirect("/login");
}
