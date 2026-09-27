import { buildPushPayload } from "@block65/webcrypto-web-push";
import { eligible, notificationType, safePushEndpoint, ROLE_KINDS, type Activity, type Candidate } from "./push-rules";
import { mensagemLembreteAntecipado, mensagemLembreteHoje } from "./adiantamento";

// a.* traz source/source_id/reservation_id mesmo sem declarados no tipo Activity
type EventRow = Activity & {
  event_id: number; event_type: string; event_revision: number; offset_minutes: number; created_at: number;
  source: string; source_id: number; reservation_id: number | null;
};
type Credentials = { publicKey: string; privateKey: string; subject: string };
type Sender = (subscription: { endpoint: string; keys: { p256dh: string; auth: string } }, payload: object) => Promise<number>;
async function rows<T>(db: D1Database, sql: string, params: (string|number|null)[] = []) {
  return (await db.prepare(sql).bind(...params).all<T>()).results;
}
async function execute(db: D1Database, sql: string, params: (string|number|null)[] = []) {
  return db.prepare(sql).bind(...params).run();
}
async function candidates(db: D1Database, type: string, kind: string, id?: number): Promise<Candidate[]> {
  const result = await rows<{ id: number; active: number; roles: string; mode: string; kindMode: string }>(db, `
    SELECT u.id,u.active,COALESCE((SELECT json_group_array(role) FROM user_operational_roles WHERE user_id=u.id),'[]') AS roles,
    COALESCE(p.mode,'auto') AS mode,COALESCE(k.mode,'auto') AS kindMode FROM users u
    LEFT JOIN notification_preferences p ON p.user_id=u.id AND p.type=?
    LEFT JOIN notification_preferences k ON k.user_id=u.id AND k.type=?
    WHERE u.active=1 ${id ? "AND u.id=?" : ""}`, id ? [type,kind,id] : [type,kind]);
  return result.map(u => ({ ...u, roles: JSON.parse(u.roles) }));
}
/**
 * Motivo da falha em uma linha, sem vazar segredo.
 *
 * Nunca cai aqui a chave privada, o endpoint ou as chaves do aparelho: URLs
 * inteiras sao removidas e o texto e cortado, entao o que sobra e o tipo do
 * erro, que e justamente o que permite distinguir cripto de rede.
 */
export function sanitizeError(e: unknown): string {
  const bruto = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  return bruto.replace(/https?:\/\/\S+/g, "[endpoint]").replace(/\s+/g, " ").trim().slice(0, 180) || "Erro desconhecido";
}

/** Texto que o dono do aparelho ve, com o caminho da solucao quando existe. */
export function explicaFalha(status: number, falha: string): string {
  if (status === 401 || status === 403) return "Servidor recusou a credencial VAPID. Confira as chaves em produção.";
  if (status === 413) return "Mensagem grande demais para o serviço de push.";
  if (status === 429) return "Serviço de push pediu para reduzir o ritmo. Será reenviado.";
  if (status >= 500) return "Serviço de push indisponível no momento. Será reenviado.";
  if (status) return `Falha de envio (HTTP ${status}).`;
  return falha ? `Falha de envio: ${falha}` : "Falha de envio (rede).";
}

export function webPushSender(credentials: Credentials): Sender {
  return async (subscription, message) => {
    if (!safePushEndpoint(subscription.endpoint)) return 410;
    const request = await buildPushPayload({ data: JSON.stringify(message), options: { ttl: 300 } }, { ...subscription, expirationTime: null }, credentials);
    // "manual" e nao "follow": um redirect nunca deve levar as credenciais VAPID
    // para outro host. O Workers nao implementa redirect:"error" e lanca
    // TypeError se ele for usado, entao o 3xx volta como resposta e cai no
    // tratamento de falha normal, que e o mesmo efeito pretendido.
    const response = await fetch(subscription.endpoint, { ...request, redirect: "manual", signal: AbortSignal.timeout(10000) });
    await response.body?.cancel();
    return response.status;
  };
}

/** Durable outbox, independent of Next request context. UTC clock; operational dates are Sao Paulo (-03:00). */
export async function runNotificationScheduler(db: D1Database, now = Math.floor(Date.now()/1000), sender?: Sender) {
  // A bounded catch-up window avoids sending yesterday's reminders after an outage.
  await execute(db, `INSERT OR IGNORE INTO notification_events(activity_id,revision,type,offset_minutes,created_at)
    SELECT a.id,a.revision,'reminder',j.value,? FROM activities a
    JOIN notification_rules r ON r.type=a.kind JOIN json_each(r.offsets) j
    WHERE a.status='pending' AND a.scheduled_at<>''
    AND unixepoch(replace(a.scheduled_at,' ','T') || '-03:00')-j.value*60 BETWEEN ? AND ?`, [now,now-300,now]);
  const events = await rows<EventRow>(db, `SELECT a.*,e.id AS event_id,e.type AS event_type,e.revision AS event_revision,e.offset_minutes,e.created_at
    FROM notification_events e JOIN activities a ON a.id=e.activity_id WHERE e.processed=0 ORDER BY e.id LIMIT 5`);
  let created = 0;
  for (const e of events) {
    if (e.revision !== e.event_revision || (e.status !== "pending" && e.event_type !== "cancelamento") || now-e.created_at > 86400) {
      await execute(db,"UPDATE notification_events SET processed=1 WHERE id=?",[e.event_id]); continue;
    }
    const type = notificationType(e.event_type,e.kind);
    const rule = await db.prepare("SELECT message FROM notification_rules WHERE type=?").bind(type).first<{ message: string }>();
    const prefix = e.event_type === "reminder" ? (e.offset_minutes ? `Em ${e.offset_minutes} min` : "Agora") : e.event_type === "cancelamento" ? "Cancelamento" : e.event_type === "alteracao" ? "Alteração" : "Novo agendamento";
    let title = `${prefix}: ${e.title}`.slice(0,180);
    let body = (rule?.message || `${e.title} — ${e.scheduled_at.replace("T"," ")}. Abra para conferir os detalhes.`).slice(0,500);
    // Adiantamento: a mesma fila de lembrete de qualquer financial_entries,
    // so com uma voz mais direta para quem cobra o cliente. Toda outra
    // notificacao (inclusive as demais parcelas a receber) segue a mensagem de cima, intocada.
    if (e.event_type === "reminder" && e.source === "financial_entries") {
      const entry = await db.prepare(
        `SELECT f.category, f.amount_cents, c.name AS customer_name
           FROM financial_entries f LEFT JOIN customers c ON c.id = f.customer_id WHERE f.id = ?`,
      ).bind(e.source_id).first<{ category: string; amount_cents: number; customer_name: string | null }>();
      if (entry?.category === "Adiantamento" && entry.customer_name) {
        // dias ate o vencimento a partir de quando o aviso dispara: 1440min
        // (24h) antes do vencimento e o vencimento em si e sempre "amanha"
        const dias = Math.round(e.offset_minutes / 1440);
        const msg = dias >= 1
          ? mensagemLembreteAntecipado(entry.customer_name, entry.amount_cents, dias)
          : mensagemLembreteHoje(entry.customer_name, entry.amount_cents);
        title = msg.title; body = msg.body;
      }
    }
    // Same precedence as eligible(), evaluated atomically with the source revision.
    // Bulk INSERTs keep the D1 query count bounded independently of team size.
    const results = await db.batch([
      db.prepare(`INSERT OR IGNORE INTO user_notifications(user_id,event_id,type,title,body,link,created_at)
        SELECT u.id,?,?,?,?,?,? FROM activities a CROSS JOIN users u
        LEFT JOIN notification_preferences p ON p.user_id=u.id AND p.type=?
        LEFT JOIN notification_preferences k ON k.user_id=u.id AND k.type=a.kind
        WHERE a.id=? AND a.revision=? AND u.active=1
        AND COALESCE(p.mode,'auto')<>'off' AND COALESCE(k.mode,'auto')<>'off'
        AND ((a.assignee_id IS NOT NULL AND a.assignee_id=u.id) OR (a.assignee_id IS NULL AND
          (p.mode='on' OR k.mode='on' OR EXISTS (
            SELECT 1 FROM user_operational_roles ur JOIN json_each(?) mapping ON mapping.key=ur.role
            JOIN json_each(mapping.value) kinds WHERE ur.user_id=u.id AND kinds.value=a.kind
          ))))`).bind(e.event_id,type,title,body,e.link,now,type,e.id,e.revision,JSON.stringify(ROLE_KINDS)),
      db.prepare(`INSERT OR IGNORE INTO push_deliveries(notification_id,subscription_id)
        SELECT n.id,s.id FROM user_notifications n JOIN push_subscriptions s ON s.user_id=n.user_id
        WHERE n.event_id=? AND s.enabled=1 AND (s.expiration_time IS NULL OR s.expiration_time>?)`).bind(e.event_id,now*1000),
      db.prepare("UPDATE notification_events SET processed=1 WHERE id=?").bind(e.event_id),
    ]);
    created += results[0].meta.changes;
  }

  // Recover crashed claims. Stable notification IDs are also deduplicated by the service worker.
  await execute(db,"UPDATE push_deliveries SET status='pending' WHERE status='sending' AND lease_until<?",[now]);
  const global = await db.prepare("SELECT value FROM settings WHERE key='push_enabled'").first<{value:string}>();
  let sent = 0;
  if (sender && global?.value !== "0") {
    const deliveries = await rows<{ id: number }>(db,"SELECT id FROM push_deliveries WHERE status='pending' AND next_attempt<=? ORDER BY id LIMIT 3",[now]);
    for (const job of deliveries) {
      const claim = await execute(db,"UPDATE push_deliveries SET status='sending',lease_until=?,attempts=attempts+1 WHERE id=? AND status='pending' AND next_attempt<=?",[now+120,job.id,now]);
      if (!claim.meta.changes) continue;
      // Re-read source, ownership, preferences and device immediately before dispatch.
      const d = await db.prepare(`SELECT d.notification_id,d.subscription_id,d.attempts,s.endpoint,s.p256dh,s.auth,s.enabled,s.user_id,s.expiration_time,
        n.title AS notification_title,n.body,n.link AS notification_link,n.type AS notification_type,n.created_at AS notification_created,
        a.*,e.revision AS event_revision,r.enabled AS rule_enabled
        FROM push_deliveries d JOIN push_subscriptions s ON s.id=d.subscription_id
        JOIN user_notifications n ON n.id=d.notification_id LEFT JOIN notification_events e ON e.id=n.event_id
        LEFT JOIN activities a ON a.id=e.activity_id LEFT JOIN notification_rules r ON r.type=n.type WHERE d.id=?`).bind(job.id).first<Activity & {
          notification_id:number; subscription_id:number; attempts:number; endpoint:string; p256dh:string; auth:string;
          enabled:number; user_id:number; expiration_time:number|null; notification_title:string;body:string;notification_link:string;
          notification_type:string;notification_created:number;event_revision:number;rule_enabled:number;
        }>();
      const recipient = d ? (await candidates(db,d.notification_type,d.kind ?? d.notification_type,d.user_id))[0] : undefined;
      // Um aviso proprio (aniversario, por exemplo) nao nasce de uma atividade:
      // ali nao ha revisao nem escala para conferir, e o que vale e o tipo estar
      // ligado e o usuario nao ter desligado. As checagens de atividade seguem
      // valendo, intactas, para tudo que veio de uma.
      const daAtividade = !!d && d.event_revision !== null && d.event_revision !== undefined;
      const permitido = !!d && !!recipient
        && !!d.enabled
        && !(d.expiration_time !== null && d.expiration_time <= now*1000)
        && !!d.rule_enabled
        && now-d.notification_created <= 3600
        && (daAtividade
          ? eligible(d,recipient) && d.revision === d.event_revision && (d.status === "pending" || d.notification_type === "cancelamento")
          : recipient.mode !== "off" && recipient.kindMode !== "off");
      if (!permitido) {
        await execute(db,"UPDATE push_deliveries SET status='cancelled' WHERE id=?",[job.id]); continue;
      }
      let status = 0;
      let falha = "";
      try {
        status = await sender({ endpoint:d.endpoint, keys:{p256dh:d.p256dh,auth:d.auth} }, {
          id:d.notification_id, title:d.notification_title, body:d.body, url:d.notification_link,
        });
      } catch (e) {
        // Sem a causa, uma chave VAPID invalida e uma queda de rede ficam iguais
        // no banco e o problema vira adivinhacao. Guardamos o motivo, nunca o
        // endpoint nem as chaves do dispositivo.
        falha = sanitizeError(e);
      }
      if (status >= 200 && status < 300) {
        await db.batch([
          db.prepare("UPDATE push_deliveries SET status='sent',sent_at=?,last_error=NULL WHERE id=?").bind(now,job.id),
          db.prepare("UPDATE push_subscriptions SET last_success_at=?,last_error=NULL WHERE id=?").bind(now,d.subscription_id),
        ]); sent++;
      } else {
        const expired = status===404 || status===410;
        const retry = (status===0 || status===429 || status>=500) && d.attempts<4;
        await db.batch([
          db.prepare("UPDATE push_deliveries SET status=?,next_attempt=?,last_error=? WHERE id=?").bind(retry?"pending":"failed",now+60*Math.pow(2,d.attempts),status?`HTTP ${status}`:(falha||"HTTP network"),job.id),
          db.prepare("UPDATE push_subscriptions SET enabled=CASE WHEN ? THEN 0 ELSE enabled END,last_error=? WHERE id=?").bind(expired?1:0,expired?"Inscricao expirada. Reative neste dispositivo.":explicaFalha(status,falha),d.subscription_id),
        ]);
      }
    }
  }
  await db.batch([
    db.prepare("DELETE FROM route_cache WHERE expires_at<?").bind(now),
    db.prepare("DELETE FROM api_rate_limits WHERE expires_at<?").bind(now),
    db.prepare("INSERT INTO scheduler_state(key,value) VALUES ('last_run',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(String(now)),
  ]);
  return { created, sent };
}
