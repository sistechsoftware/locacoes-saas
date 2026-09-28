import "server-only";
import crypto from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { all, one, run } from "./db";
import { canEdit, canView, type Module, type Role } from "./roles";

export type { Role } from "./roles";

export type SessionUser = {
  id: number;
  name: string;
  username: string;
  role: Role;
  company_id: number;
  /** Foto de perfil (URL /api/arquivo/<id>) ou null quando nao tem. */
  avatar_url: string | null;
};

/** Contexto autenticado: o company_id vem SEMPRE daqui — nunca do cliente. */
export type CompanyContext = {
  user: SessionUser;
  company: { id: number; name: string; active: number };
  role: Role;
  companyId: number;
};

const COOKIE = "limas_session";
const SESSION_DAYS = 30;

/**
 * Cookie da requisicao, quando existe.
 *
 * Rotinas sem request (cron, seed, testes diretos) chamam funcoes que tentam
 * ler a sessao; fora de request o next/headers lanca. Aqui isso vira "sem
 * sessao" — e o chamador decide o fallback (empresa padrao do banco).
 */
async function cookiesDaRequest() {
  try {
    return await cookies();
  } catch {
    return null;
  }
}

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

/**
 * Empresa da requisição.
 *
 * O `companyId` é derivado EXCLUSIVAMENTE do usuário da sessão (users.company_id,
 * migration 0027). Nenhum parâmetro, header ou corpo de requisição participa
 * desta decisão — é aqui que o isolamento entre empresas começa.
 */async function userCompanyContext(userId: string) {
  return await one<{
    id: number;
    name: string;
    username: string;
    role: Role;
    company_id: number;
    avatar_url: string | null;
    user_active: number;
    company_active: number;
    company_name: string;
    expires_at: string;
  }>(
    `SELECT u.id, u.name, u.username, u.role, u.company_id, u.avatar_url,
            u.active AS user_active, c.active AS company_active, c.name AS company_name,
            s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id
       JOIN companies c ON c.id = u.company_id
      WHERE s.id = ?`,
    [userId],
  );
}

/** Usuario da requisicao atual, ou null. */
export async function currentUser(): Promise<SessionUser | null> {
  const jar = await cookiesDaRequest();
  const id = jar?.get(COOKIE)?.value;
  if (!id) return null;
  const row = await userCompanyContext(id);
  if (!row) return null;
  if (!row.user_active || !row.company_active || new Date(row.expires_at) < new Date()) {
    await run("DELETE FROM sessions WHERE id = ?", [id]);
    return null;
  }
  return {
    id: row.id,
    name: row.name,
    username: row.username,
    role: row.role,
    company_id: row.company_id,
    avatar_url: row.avatar_url,
  };
}

/**
 * Contexto completo da empresa autenticada.
 *
 * Ponto de entrada obrigatório das páginas/actions/APIs de tenant: devolve o
 * usuário, a empresa e o papel. Usuário inativo, empresa inativa ou sessão
 * expirada = sem contexto (a sessão é destruída).
 */
export async function companyContext(): Promise<CompanyContext | null> {
  const jar = await cookiesDaRequest();
  const id = jar?.get(COOKIE)?.value;
  if (!id) return null;
  const row = await userCompanyContext(id);
  if (!row) return null;
  if (!row.user_active || !row.company_active || new Date(row.expires_at) < new Date()) {
    await run("DELETE FROM sessions WHERE id = ?", [id]);
    return null;
  }
  return {
    user: {
      id: row.id,
      name: row.name,
      username: row.username,
      role: row.role,
      company_id: row.company_id,
      avatar_url: row.avatar_url,
    },
    company: { id: row.company_id, name: row.company_name, active: row.company_active },
    role: row.role,
    companyId: row.company_id,
  };
}

/**
 * company_id da requisição atual.
 *
 * Com sessão: empresa do usuário autenticado. Sem request (cron/seed/testes):
 * empresa padrão do banco. Em tela NENHUM fluxo chega aqui sem sessão, porque
 * as actions exigem contexto antes de escrever.
 */
export async function companyIdFromRequestContext(): Promise<number> {
  // Contexto do agendador (runWithCompany) tem prioridade: dentro do cron nao
  // existe sessao, e a empresa e a que a rotina esta processando. Depois vem a
  // sessao (fonte de autoridade em request) e, por fim, a empresa padrao.
  const { companyContextAtual, currentCompanyId } = await import("./db");
  const fixada = companyContextAtual();
  if (fixada !== undefined) return fixada;
  const ctx = await companyContext();
  if (ctx) return ctx.companyId;
  return await currentCompanyId();
}

/** Exige usuario logado; redireciona para /login caso contrario. */
export async function requireUser(): Promise<SessionUser> {
  const u = await currentUser();
  if (!u) redirect("/login");
  return u;
}

/**
 * Exige contexto de empresa; redireciona para /login caso contrario.
 * Páginas de leitura de tenant devem usar este em vez de requireUser.
 */
export async function requireCompanyContext(): Promise<CompanyContext> {
  const ctx = await companyContext();
  if (!ctx) redirect("/login");
  return ctx;
}

/**
 * Exige contexto de empresa COM direito de visualizar o módulo.
 * Uso nas páginas (server components) de cada módulo.
 */
export async function requireModule(module: Module): Promise<CompanyContext> {
  const ctx = await requireCompanyContext();
  if (!canView(ctx.role, module)) redirect("/dashboard?erro=permissao");
  return ctx;
}

/**
 * Exige contexto de empresa COM direito de EDITAR o módulo.
 * Uso nas server actions: o viewer/financeiro que tentar chamar a action
 * diretamente recebe PermissionError — não é escondido só na interface.
 */
export async function requireModuleEdit(module: Module): Promise<CompanyContext> {
  const ctx = await requireCompanyContext();
  if (!canEdit(ctx.role, module)) throw new PermissionError();
  return ctx;
}

/** Papel admin/owner (compat: painéis internos herdados). */
function isAdminRole(role: Role): boolean {
  return role === "owner" || role === "admin";
}

/** Exige papel admin. Lanca erro em server actions, redireciona em paginas. */
export async function requireAdmin(): Promise<SessionUser> {
  const u = await requireUser();
  if (!isAdminRole(u.role)) redirect("/dashboard?erro=permissao");
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
  if (!isAdminRole(u.role)) throw new PermissionError();
  return u;
}

export async function listUsers() {
  const ctx = await companyContext();
  if (!ctx) return [];
  return await all(
    `SELECT id, name, username, email, phone, role, active, avatar_url, created_at
       FROM users WHERE company_id = ? ORDER BY name`,
    [ctx.companyId],
  );
}

export async function purgeExpiredSessions() {
  await run("DELETE FROM sessions WHERE expires_at < ?", [new Date().toISOString()]);
}
