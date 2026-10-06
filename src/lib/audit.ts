import "server-only";
import { all, insert } from "./db";
import { headers } from "next/headers";
import type { SessionUser } from "./auth";

/**
 * Registra uma alteração relevante no histórico da empresa.
 *
 * O escopo vem do usuário (user.company_id) — nunca de parâmetro. IP e
 * user-agent entram quando existem (fora de request, como no cron, ficam
 * nulos). Nenhum segredo/senha deve ser passado em `meta`.
 */
export async function logAction(
  user: SessionUser | null,
  action: string,
  entity: string,
  entityId: number | null,
  summary: string,
  meta?: unknown,
) {
  let ip: string | null = null;
  let userAgent: string | null = null;
  try {
    const h = await headers();
    ip = h.get("cf-connecting-ip") || h.get("x-forwarded-for")?.split(",")[0]?.trim() || null;
    userAgent = h.get("user-agent");
  } catch {
    // sem request (cron/rotinas): segue sem rede
  }
  /* Pendência #04: gravamos as DUAS colunas com o mesmo escopo — o legado
     company_id (que nasceu DEFAULT 1 e continuaria apontando para o tenant 1
     em toda auditoria) e o company_id_ref, que e o escopo de leitura. */
  await insert(
    `INSERT INTO audit_logs (user_id, user_name, action, entity, entity_id, summary, meta, company_id_ref, company_id, ip, user_agent)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [
      user?.id ?? null,
      user?.name ?? "sistema",
      action,
      entity,
      entityId,
      summary,
      meta ? JSON.stringify(meta) : null,
      user?.company_id ?? null,
      user?.company_id ?? 1,
      ip,
      userAgent ? userAgent.slice(0, 300) : null,
    ],
  );
}

/** Histórico da empresa autenticada (tela /historico). */
export async function recentLogs(limit = 100, offset = 0, companyId?: number) {
  let cid = companyId;
  if (cid === undefined) {
    const { companyIdFromRequestContext } = await import("./auth");
    cid = await companyIdFromRequestContext();
  }
  return await all(
    `SELECT * FROM audit_logs WHERE company_id_ref = ? ORDER BY id DESC LIMIT ? OFFSET ?`,
    [cid, limit, offset],
  );
}

export async function logsFor(entity: string, entityId: number, companyId?: number) {
  let cid = companyId;
  if (cid === undefined) {
    const { companyIdFromRequestContext } = await import("./auth");
    cid = await companyIdFromRequestContext();
  }
  return await all(
    `SELECT * FROM audit_logs WHERE entity = ? AND entity_id = ? AND company_id_ref = ? ORDER BY id DESC`,
    [entity, entityId, cid],
  );
}
