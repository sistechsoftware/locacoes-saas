export const NOTIFICATION_TYPES = {
  entrega: "Entregas", retirada: "Retiradas", montagem: "Montagens", desmontagem: "Desmontagens",
  separacao: "Separacao de materiais", reserva: "Reservas", frete: "Fretes", financeiro: "Financeiro",
  alteracao: "Alteracoes", cancelamento: "Cancelamentos", aniversario: "Aniversariantes",
  chat: "Mensagens do chat",
};
export type NotificationType = keyof typeof NOTIFICATION_TYPES;
export const OFFSETS = [1440, 720, 120, 60, 30, 15, 0];
export const ROLE_KINDS: Record<string, string[]> = {
  entregador: ["entrega", "frete"], retirador: ["retirada"], montador: ["montagem", "desmontagem"],
  separador: ["separacao"], financeiro: ["financeiro"], comercial: ["reserva", "frete"],
  gestor: ["entrega", "retirada", "montagem", "desmontagem", "separacao", "reserva", "frete", "financeiro"],
};
export type Activity = {
  id: number; kind: string; title: string; scheduled_at: string; link: string;
  status: "pending" | "completed" | "cancelled"; assignee_id: number | null; revision: number;
};
export type Candidate = { id: number; active: number; roles: string[]; mode: string; kindMode: string };

/** Access level ('admin') is deliberately not an input. Assignment overrides team defaults. */
export function eligible(a: Pick<Activity,"kind"|"assignee_id">, u: Candidate) {
  if (!u.active || u.mode === "off" || u.kindMode === "off") return false;
  if (a.assignee_id !== null) return a.assignee_id === u.id;
  return u.mode === "on" || u.kindMode === "on" || u.roles.some(role => ROLE_KINDS[role]?.includes(a.kind));
}
export function notificationType(eventType: string, kind: string) {
  return eventType === "created" || eventType === "reminder" ? kind : eventType;
}
export function safePushEndpoint(endpoint: string) {
  try {
    const u = new URL(endpoint);
    return u.protocol === "https:" && !u.username && !u.password && !u.port && endpoint.length <= 2048 && (
      u.hostname === "fcm.googleapis.com" || u.hostname === "updates.push.services.mozilla.com" ||
      u.hostname === "web.push.apple.com" || u.hostname.endsWith(".push.apple.com") ||
      u.hostname.endsWith(".notify.windows.com")
    );
  } catch { return false; }
}
export function validateSubscription(value: { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } }) {
  const endpoint = String(value?.endpoint ?? ""), p256dh = String(value?.keys?.p256dh ?? ""), auth = String(value?.keys?.auth ?? "");
  if (!safePushEndpoint(endpoint) || !/^[A-Za-z0-9_-]{87}$/.test(p256dh) || !/^[A-Za-z0-9_-]{22}$/.test(auth)) throw new Error("Inscricao push invalida.");
  return { endpoint, p256dh, auth };
}
export function validOffsets(value: unknown): number[] {
  if (!Array.isArray(value) || value.length > OFFSETS.length || value.some(x => !OFFSETS.includes(x))) throw new Error("Antecedencias invalidas.");
  return [...new Set(value)];
}
