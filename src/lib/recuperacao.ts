/**
 * Recuperação de senha (Etapa 5).
 *
 * Fluxo: usuário pede redefinição -> grava token opaco (SHA-256 no banco,
 * 1 hora) -> e-mail com link -> usuário define a senha nova (token consumido,
 * sessões anteriores encerradas).
 *
 * Sem next/* no topo: a lógica vive aqui, testável com FakeD1; o rate limit
 * fica na server action. Sem e-mail configurado o sistema segue funcionando —
 * o pedido simplesmente não chega por e-mail até o Resend ser configurado.
 * A resposta pública é SEMPRE idêntica, com ou sem usuário, para não servir
 * de dicionário de contas.
 */

import crypto from "node:crypto";
import { one, run } from "./db";
import { hashPassword } from "./password";
import { enviarEmail } from "./email";

const TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hora

function sha256(texto: string): string {
  return crypto.createHash("sha256").update(texto).digest("hex");
}

/** Token opaco de alta entropia (256 bits) — o banco guarda só o hash. */
function gerarToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

/** Origem da requisição para montar o link do e-mail ('' fora de request). */
async function baseUrl(): Promise<string> {
  try {
    const { headers } = await import("next/headers");
    const h = await headers();
    const host = h.get("x-forwarded-host") || h.get("host") || "";
    const proto = h.get("x-forwarded-proto") || "https";
    return host ? `${proto}://${host}` : "";
  } catch {
    return "";
  }
}

/**
 * Cria o pedido de redefinição (se o usuário existir) e envia o e-mail.
 * Nunca revela se o usuário existe: devolve ok:true em todos os caminhos.
 */
export async function pedirRedefinicao(entrada: { username: string }): Promise<{ ok: true }> {
  const username = String(entrada.username ?? "").trim().toLowerCase();
  if (!username) return { ok: true };

  const user = await one<{ id: number; name: string; email: string | null }>(
    `SELECT id, name, email FROM users WHERE lower(username) = ? AND active = 1`,
    [username],
  );
  if (!user) return { ok: true };

  // Um pedido ativo por usuário: os anteriores morrem aqui.
  await run(`DELETE FROM password_resets WHERE user_id = ?`, [user.id]);
  const token = gerarToken();
  await run(`INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?,?,?)`, [
    user.id,
    sha256(token),
    new Date(Date.now() + TOKEN_TTL_MS).toISOString(),
  ]);

  const base = await baseUrl();
  await enviarEmail({
    to: user.email ?? "",
    subject: "Redefinição de senha — Locô",
    html: emailHtml(`${base}/redefinir-senha?token=${token}`, user.name),
    text: `Para redefinir sua senha, abra o link (expira em 1 hora): ${base}/redefinir-senha?token=${token}`,
  });
  return { ok: true };
}

function emailHtml(link: string, nome: string): string {
  return `<p>Olá, ${nome}.</p>
   <p>Recebemos um pedido de redefinição de senha para a sua conta no sistema Locô — Gestão para locações.</p>
   <p><a href="${link}" style="display:inline-block;background:#C94F00;color:#ffffff;text-decoration:none;font-weight:700;font-size:14px;border-radius:12px;padding:12px 20px;">Definir nova senha</a></p>
   <p>Se o botão não abrir, copie e cole no navegador:<br>${link}</p>
   <p>O link expira em 1 hora e só pode ser usado uma vez. Se não foi você, ignore este e-mail.</p>`;
}

export type ResultadoRedefinicao = { ok: true } | { ok: false; erro: string };

/**
 * Aplica a senha nova: token válido, não usado e não expirado. Encerra as
 * sessões do usuário (a senha velha não pode manter alguém dentro) e consome
 * o token (uso único).
 */
export async function aplicarRedefinicao(entrada: { token: string; senha: string }): Promise<ResultadoRedefinicao> {
  const token = String(entrada.token ?? "").trim();
  const senha = String(entrada.senha ?? "");
  if (!token) return { ok: false, erro: "Link inválido. Solicite uma nova redefinição." };
  if (senha.length < 8) return { ok: false, erro: "A senha precisa ter pelo menos 8 caracteres." };

  const linha = await one<{ id: number; user_id: number; expires_at: string; used_at: string | null }>(
    `SELECT id, user_id, expires_at, used_at FROM password_resets WHERE token_hash = ?`,
    [sha256(token)],
  );
  if (!linha || linha.used_at) return { ok: false, erro: "Link inválido ou já utilizado. Solicite uma nova redefinição." };
  if (new Date(linha.expires_at) < new Date()) return { ok: false, erro: "Link expirado. Solicite uma nova redefinição." };

  const user = await one<{ id: number; active: number }>(`SELECT id, active FROM users WHERE id = ?`, [linha.user_id]);
  if (!user || !user.active) return { ok: false, erro: "Link inválido. Solicite uma nova redefinição." };

  await run(`UPDATE users SET password_hash = ? WHERE id = ?`, [hashPassword(senha), user.id]);
  await run(`DELETE FROM sessions WHERE user_id = ?`, [user.id]);
  await run(`UPDATE password_resets SET used_at = datetime('now','localtime') WHERE id = ?`, [linha.id]);

  // Auditoria fora de request (null): o contexto vem do token, não de sessão.
  const { logAction } = await import("./audit");
  await logAction(null, "senha", "usuario", user.id, "Senha redefinida via e-mail (token de uso único)");
  return { ok: true };
}

/** Limpeza de tokens vencidos (chamada pelo cron junto da rotina de billing). */
export async function limparTokensExpirados(): Promise<number> {
  const antes = await one<{ n: number }>(`SELECT COUNT(*) AS n FROM password_resets WHERE expires_at < ?`, [
    new Date().toISOString(),
  ]);
  await run(`DELETE FROM password_resets WHERE expires_at < ?`, [new Date().toISOString()]);
  return antes?.n ?? 0;
}
