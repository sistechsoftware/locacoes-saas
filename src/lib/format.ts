/** Utilitarios de formatacao e datas. Sem dependencia de servidor. */

export const money = (cents: number | null | undefined) =>
  ((cents ?? 0) / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

export const moneyShort = (cents: number | null | undefined) => {
  const v = (cents ?? 0) / 100;
  if (Math.abs(v) >= 1000)
    return "R$ " + (v / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 1 }) + "k";
  return money(cents);
};

/** "1.234,56" ou "1234.56" -> centavos */
export function parseMoney(input: string | number | null | undefined): number {
  if (input === null || input === undefined || input === "") return 0;
  if (typeof input === "number") return Math.round(input * 100);
  const s = String(input).trim().replace(/[^\d,.-]/g, "");
  if (!s) return 0;
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  let normalized = s;
  if (lastComma > lastDot) normalized = s.replace(/\./g, "").replace(",", ".");
  else normalized = s.replace(/,/g, "");
  const n = Number(normalized);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

/**
 * O texto digitado e um valor que da para ler?
 *
 * parseMoney devolve 0 tanto para "zero" quanto para "nao entendi", e essa
 * ambiguidade ja custou lancamentos: o sistema descartava em silencio o que
 * nao conseguia interpretar. Aqui a pergunta e outra, e a resposta permite
 * dizer a pessoa exatamente o que aconteceu.
 */
export function valorValido(input: string | number | null | undefined): boolean {
  if (typeof input === "number") return Number.isFinite(input);
  const bruto = String(input ?? "").trim();
  if (!bruto) return false;
  const s = bruto.replace(/[^\d,.-]/g, "");
  if (!s || !/\d/.test(s)) return false;
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  const normalized = lastComma > lastDot ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  return Number.isFinite(Number(normalized));
}

/* ------------------------------- datas ------------------------------ */

/**
 * Fuso do negocio.
 *
 * O servidor (Worker da Cloudflare) roda em UTC, entao `new Date().getDate()`
 * la vira o dia seguinte a partir das 21h no horario de Brasilia. Como toda a
 * regra do sistema e baseada em "hoje" (entregas do dia, atrasos, alertas),
 * as datas sao sempre calculadas neste fuso, e nunca no fuso do servidor.
 */
export const FUSO = "America/Sao_Paulo";

const FORMATADOR = new Intl.DateTimeFormat("en-CA", {
  timeZone: FUSO,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** Partes da data conforme o relogio de parede do fuso do negocio. */
function partesNoFuso(d: Date) {
  const p: Record<string, string> = {};
  for (const parte of FORMATADOR.formatToParts(d)) {
    if (parte.type !== "literal") p[parte.type] = parte.value;
  }
  // en-CA usa 24h, mas a meia-noite pode vir como "24"
  const hora = p.hour === "24" ? "00" : p.hour;
  return { ano: p.year, mes: p.month, dia: p.day, hora, minuto: p.minute };
}

/** Data de hoje no fuso do negocio, formato YYYY-MM-DD. */
export function today(): string {
  const { ano, mes, dia } = partesNoFuso(new Date());
  return `${ano}-${mes}-${dia}`;
}

/** Data e hora de agora no fuso do negocio, formato YYYY-MM-DDTHH:MM. */
export function nowLocal(): string {
  const { ano, mes, dia, hora, minuto } = partesNoFuso(new Date());
  return `${ano}-${mes}-${dia}T${hora}:${minuto}`;
}

/**
 * Janela de busca equivalente a "as ultimas 3 horas" no fuso do negocio.
 *
 * Devolve o dia (YYYY-MM-DD) a partir do qual vale comparar colunas de DATA
 * pura com o indice, em vez de embutir date('now','-3 hours') na SQL — dentro
 * do banco, 'now' e UTC e a aritmetica em coluna impede o uso de indice
 * (varredura inteira em customers/reservations a cada leitura).
 */
export function cutoff3h(): string {
  const { ano, mes, dia } = partesNoFuso(new Date(Date.now() - 3 * 3600 * 1000));
  return `${ano}-${mes}-${dia}`;
}

export function toISODate(d: Date): string {
  const { ano, mes, dia } = partesNoFuso(d);
  return `${ano}-${mes}-${dia}`;
}

export function toISODateTime(d: Date): string {
  const { ano, mes, dia, hora, minuto } = partesNoFuso(d);
  return `${ano}-${mes}-${dia}T${hora}:${minuto}`;
}

/**
 * Converte um instante gravado em UTC pelo banco para o texto do fuso local.
 * Usado nos carimbos criados por datetime('now'), que no Worker saem em UTC.
 */
/**
 * Data de um carimbo gravado pelo banco, no fuso de Brasilia.
 *
 * O default das colunas e datetime('now','localtime'), que no Worker da
 * Cloudflare devolve UTC porque a maquina roda em UTC. Exibir esse texto direto
 * mostra tres horas a mais e, entre 21h e meia-noite, o dia seguinte: um
 * orcamento emitido as 22h de segunda sairia impresso como terca.
 */
export function dateUtcBR(s: string | null | undefined): string {
  const completo = utcParaLocal(s);
  return completo === "-" ? "-" : completo.slice(0, 10);
}

export function utcParaLocal(s: string | null | undefined): string {
  if (!s) return "-";
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(s);
  if (!m) return s;
  const utc = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]));
  const { ano, mes, dia, hora, minuto } = partesNoFuso(utc);
  return `${dia}/${mes}/${ano} ${hora}:${minuto}`;
}

/**
 * Interpreta "YYYY-MM-DD" ou "YYYY-MM-DDTHH:MM" como DATA DE CALENDARIO.
 *
 * Estas strings sao datas de agenda ("o evento e dia 10/10"), nao instantes:
 * nao carregam fuso nenhum. Por isso a ancora e criada em UTC e toda a
 * aritmetica abaixo usa os getters UTC. Montar em fuso do servidor e depois
 * formatar no fuso do negocio somava a diferenca entre os dois e deslocava a
 * data em um dia.
 */
export function parseLocal(s: string | null | undefined): Date | null {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(s);
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], m[4] ? +m[4] : 0, m[5] ? +m[5] : 0));
}

/** YYYY-MM-DD de uma ancora de calendario (sempre pelos campos UTC). */
function calendarioISO(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

export function addDays(dateISO: string, days: number): string {
  const d = parseLocal(dateISO);
  if (!d) return dateISO;
  d.setUTCDate(d.getUTCDate() + days);
  return calendarioISO(d);
}

export const dateBR = (s: string | null | undefined) => {
  const d = parseLocal(s);
  return d ? d.toLocaleDateString("pt-BR", { timeZone: "UTC" }) : "-";
};

export const timeBR = (s: string | null | undefined) => {
  if (!s) return "-";
  const m = /[T ](\d{2}):(\d{2})/.exec(s);
  if (m) return `${m[1]}:${m[2]}`;
  return /^\d{2}:\d{2}$/.test(s) ? s : "-";
};

export const dateTimeBR = (s: string | null | undefined) => {
  const d = parseLocal(s);
  if (!d) return "-";
  return `${d.toLocaleDateString("pt-BR", { timeZone: "UTC" })} ${timeBR(s)}`;
};

export const weekdayBR = (s: string) =>
  (parseLocal(s) ?? new Date())
    .toLocaleDateString("pt-BR", { weekday: "short", timeZone: "UTC" })
    .replace(".", "");

export const monthLabel = (s: string) =>
  (parseLocal(s + "-01") ?? new Date()).toLocaleDateString("pt-BR", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

/** Segunda-feira da semana da data informada. */
export function startOfWeek(dateISO: string): string {
  const d = parseLocal(dateISO);
  if (!d) return dateISO;
  const wd = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - wd);
  return calendarioISO(d);
}

export function startOfMonth(dateISO: string): string {
  return dateISO.slice(0, 7) + "-01";
}

export function endOfMonth(dateISO: string): string {
  const d = parseLocal(startOfMonth(dateISO));
  if (!d) return dateISO;
  d.setUTCMonth(d.getUTCMonth() + 1);
  d.setUTCDate(0);
  return calendarioISO(d);
}

/**
 * Data por extenso em português, para o contrato digital.
 *
 * "2026-09-12" vira "12 de setembro de 2026". Segue a mesma regra das demais
 * datas: a entrada e data de calendario (YYYY-MM-DD), sem fuso, e a formatacao
 * usa os campos UTC — nunca o relogio do servidor, que roda em UTC e poderia
 * deslocar o dia.
 */
export function dataPorExtensoBR(dataISO: string | null | undefined): string {
  const d = parseLocal(dataISO);
  return d ? d.toLocaleDateString("pt-BR", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }) : "";
}

export function daysBetween(a: string, b: string): number {
  const da = parseLocal(a)!, dbb = parseLocal(b)!;
  return Math.round((dbb.getTime() - da.getTime()) / 864e5);
}

/* ------------------------------ diversos ---------------------------- */

export const onlyDigits = (s: string | null | undefined) => (s ?? "").replace(/\D/g, "");

export function phoneBR(s: string | null | undefined) {
  const d = onlyDigits(s);
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return s ?? "";
}

/** Monta link wa.me com mensagem pre-preenchida. */
export function waLink(phone: string | null | undefined, message: string) {
  let d = onlyDigits(phone);
  if (!d) return null;
  if (d.length <= 11) d = "55" + d;
  return `https://wa.me/${d}?text=${encodeURIComponent(message)}`;
}

export function mapsLink(...parts: (string | null | undefined)[]) {
  const q = parts.filter(Boolean).join(", ");
  if (!q) return null;
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(q)}`;
}

export const docBR = (s: string | null | undefined) => {
  const d = onlyDigits(s);
  if (d.length === 11) return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
  if (d.length === 14) return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
  return s ?? "";
};

export function initials(name: string) {
  return name.trim().split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? "").join("");
}
