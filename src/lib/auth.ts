import "server-only";
import crypto from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { all, one, run } from "./db";

export type Role = "admin" | "operador";

export type SessionUser = {
  id: number;
  name: string;
  username: string;
  role: Role;
  /** Foto de perfil (URL /api/arquivo/<id>) ou null quando nao tem. */
  avatar_url: string | null;
};

const COOKIE = "limas_session";
const SESSION_DAYS = 30;

/* ------------------------------ senhas ------------------------------ */

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [algo, salt, hash] = stored.split("$");
  if (algo !== "scrypt" || !salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, "hex");
  if (candidate.length !== expected.length) return false;
  return crypto.timingSafeEqual(candidate, expected);
}

/* ------------------------------ sessao ------------------------------ */

export async function createSession(userId: number) {
  const id = crypto.randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5);
  await run("INSERT INTO sessions (id, user_id, expires_at) VALUES (?,?,?)", [
    id,
    userId,
    expires.toISOString(),
  ]);
  const jar = await cookies();
  jar.set(COOKIE, id, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    expires,
    secure: process.env.NODE_ENV === "production",
  });
}

export async function destroySession() {
  const jar = await cookies();
  const id = jar.get(COOKIE)?.value;
  if (id) await run("DELETE FROM sessions WHERE id = ?", [id]);
  jar.delete(COOKIE);
}

/** Usuario da requisicao atual, ou null. */
export async function currentUser(): Promise<SessionUser | null> {
  const jar = await cookies();
  const id = jar.get(COOKIE)?.value;
  if (!id) return null;
  const row = await one<SessionUser & { expires_at: string; active: number }>(
    `SELECT u.id, u.name, u.username, u.role, u.active, u.avatar_url, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = ?`,
    [id],
  );
  if (!row) return null;
  if (!row.active || new Date(row.expires_at) < new Date()) {
    await run("DELETE FROM sessions WHERE id = ?", [id]);
    return null;
  }
  return { id: row.id, name: row.name, username: row.username, role: row.role, avatar_url: row.avatar_url };
}

/** Exige usuario logado; redireciona para /login caso contrario. */
export async function requireUser(): Promise<SessionUser> {
  const u = await currentUser();
  if (!u) redirect("/login");
  return u;
}

/** Exige papel admin. Lanca erro em server actions, redireciona em paginas. */
export async function requireAdmin(): Promise<SessionUser> {
  const u = await requireUser();
  if (u.role !== "admin") redirect("/dashboard?erro=permissao");
  return u;
}

export class PermissionError extends Error {
  constructor(message = "Somente o administrador pode executar esta acao.") {
    super(message);
    this.name = "PermissionError";
  }
}

/** Igual a requireAdmin, mas para uso dentro de server actions. */
export async function assertAdmin(): Promise<SessionUser> {
  const u = await requireUser();
  if (u.role !== "admin") throw new PermissionError();
  return u;
}

export async function listUsers() {
  return await all(`SELECT id, name, username, email, phone, role, active, avatar_url, created_at FROM users ORDER BY name`);
}

export async function purgeExpiredSessions() {
  await run("DELETE FROM sessions WHERE expires_at < ?", [new Date().toISOString()]);
}
