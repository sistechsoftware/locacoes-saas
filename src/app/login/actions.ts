"use server";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createSession, destroySession, verifyPassword, destinoAposLogin } from "@/lib/auth";
import { localizarConta } from "@/lib/contas";
import { logAction } from "@/lib/audit";
import { rateLimit } from "@/lib/rate-limit";

/** Proteção anti-força-bruta: limites moderados, sem lockout permanente. */
const IP_LIMIT = 20; // tentativas por IP na janela
const USER_LIMIT = 8; // tentativas por identificador na janela
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
  // Identificador único: CPF, CNPJ ou e-mail (a classificação acontece em
  // identidade.ts). Contas antigas continuam entrando pelo usuário de login —
  // mesmo campo, mesmo fluxo.
  const identificador = String(formData.get("identifier") ?? formData.get("username") ?? "")
    .trim()
    .slice(0, 160);
  const password = String(formData.get("password") ?? "");
  if (!identificador || !password) return "Informe CPF/CNPJ (ou e-mail) e senha.";

  // Rate limit ANTES de tocar na conta: a mensagem é genérica para não
  // revelar se o identificador existe. Falha do limitador não bloqueia o login.
  let permitido = true;
  try {
    const ip = await ipDaRequisicao();
    const chaveIdentificador = identificador.toLowerCase();
    permitido =
      (await rateLimit(`login:ip:${ip}`, IP_LIMIT, WINDOW_SECONDS)) &&
      (await rateLimit(`login:user:${chaveIdentificador}`, USER_LIMIT, WINDOW_SECONDS));
  } catch {
    permitido = true;
  }
  if (!permitido) return "Muitas tentativas. Aguarde alguns minutos e tente novamente.";

  // Conta ambígua (dado legado duplicado) devolve null — nunca escolhe uma
  // conta ao acaso. Mensagem idêntica para inexistente, inativa ou senha errada.
  const user = await localizarConta(identificador);
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
