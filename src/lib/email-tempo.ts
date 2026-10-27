/**
 * Tempo dos lembretes de e-mail: fuso configurável por empresa e janela de
 * envio (hora mínima).
 *
 * Convenção do sistema: as datas gravadas em reservas/operacoes são relógio
 * de parede (YYYY-MM-DDTHH:MM) no fuso do negócio — America/Sao_Paulo por
 * padrão (mesma regra de src/lib/format.ts). Aqui convertemos esse relógio de
 * parede em instante (epoch) usando o fuso configurado pela empresa, para o
 * agendador decidir QUANDO um lembrete vence sem depender do fuso do Worker
 * (que roda em UTC).
 *
 * Tudo puro e sem banco: testável com entradas fixas.
 */

const SP = "America/Sao_Paulo";

/** Fuso aceito como configuração (IANA válido e consultável no runtime). */
export function fusoValido(fuso: unknown): boolean {
  const v = String(fuso ?? "").trim();
  if (!/^[A-Za-z]+\/[A-Za-z_]+$/.test(v)) return false;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: v });
    return true;
  } catch {
    return false;
  }
}

/** Fuso aceito; qualquer coisa estranha cai no padrão do negócio. */
export function fusoSeguro(fuso: unknown): string {
  const v = String(fuso ?? "").trim();
  return fusoValido(v) ? v : SP;
}

/**
 * Relógio de parede do fuso, interpretado como se fosse UTC (em ms).
 * É a ponte entre "2026-10-25T08:00" gravado e um instante comparável a
 * `now` do cron.
 */
function wallComoUtc(fuso: string, ms: number): number {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: fuso,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const p: Record<string, string> = {};
  for (const parte of fmt.formatToParts(new Date(ms))) {
    if (parte.type !== "literal") p[parte.type] = parte.value;
  }
  const hora = p.hour === "24" ? "00" : p.hour;
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(hora), Number(p.minute), Number(p.second));
}

/**
 * Deslocamento do fuso em minutos (leste positivo; São Paulo = -180).
 * Derivado da diferença entre o relógio de parede e o instante real.
 */
export function offsetMinutos(fuso: unknown, ms: number): number {
  const tz = fusoSeguro(fuso);
  try {
    return Math.round((wallComoUtc(tz, ms) - ms) / 60000);
  } catch {
    return -180;
  }
}

/**
 * Sufixo de fuso no formato que o SQLite entende ("-03:00"), para montar
 * `unixepoch(relógio || sufixo)` em SQL — a mesma técnica já usada pelo
 * agendador de push (push-scheduler.ts).
 */
export function sufixoFuso(fuso: unknown, ms: number): string {
  const off = offsetMinutos(fuso, ms);
  const sinal = off < 0 ? "-" : "+";
  const abs = Math.abs(off);
  const h = String(Math.floor(abs / 60)).padStart(2, "0");
  const m = String(abs % 60).padStart(2, "0");
  return `${sinal}${h}:${m}`;
}

/**
 * Relógio de parede ("YYYY-MM-DDTHH:MM" ou "YYYY-MM-DD HH:MM") → epoch (segundos).
 * Texto malformado devolve 0 — quem chama trata como "sem âncora" e não agenda.
 */
export function epochDeWallClock(local: unknown, fuso?: unknown): number {
  const texto = String(local ?? "").trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(texto);
  if (!m) return 0;
  const semMinuto = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  const off = offsetMinutos(fuso ?? SP, semMinuto);
  return Math.floor((semMinuto - off * 60000) / 1000);
}

/**
 * Instante → relógio de parede no fuso ("YYYY-MM-DDTHH:MM").
 * É a operação inversa de epochDeWallClock e serve para montar os limites de
 * janela em SQL usando o índice por data/hora das tabelas (a comparação é
 * string a string, e ISO ordena cronologicamente).
 */
export function wallClockIso(epochSegundos: number, fuso?: unknown): string {
  const tz = fusoSeguro(fuso);
  const ms = Math.floor(epochSegundos * 1000);
  const off = offsetMinutos(tz, ms);
  const d = new Date(ms + off * 60000);
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`
  );
}

/** "HH:MM" válido → minutos do dia; fora do padrão, 480 (08:00). */
export function minutosDaHora(hora: unknown): number {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(hora ?? "").trim());
  if (!m) return 8 * 60;
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * Instante em que um LEMBRETE deve ser enviado.
 *
 * `gatilho` é a âncora do evento menos a antecedência. A hora de envio da
 * empresa age como piso: lembrete que cairia antes da hora configurada espera
 * até ela no mesmo dia local; o que cai depois segue o gatilho. E-mails
 * imediatos (confirmação, status) não passam por aqui — confirmação não pode
 * esperar até as 8h.
 */
export function agendarLembrete(gatilho: number, cfg: { horaEnvio: string; fuso: string }): number {
  if (!gatilho || gatilho <= 0) return 0;
  const tz = fusoSeguro(cfg.fuso);
  const alvo = minutosDaHora(cfg.horaEnvio);
  const off = offsetMinutos(tz, gatilho * 1000);
  // relógio de parede do gatilho, em minutos desde a meia-noite local
  const wall = gatilho * 1000 + off * 60000;
  const noDia = ((wall % 86400000) + 86400000) % 86400000;
  const minutoLocal = Math.floor(noDia / 60000);
  if (minutoLocal >= alvo) return gatilho;
  const inicioDoDia = wall - noDia;
  const deslocado = inicioDoDia + alvo * 60000;
  return Math.floor((deslocado - off * 60000) / 1000);
}

/** Janela de captação de gatilhos: 5 minutos de tolerância para atrasos do cron. */
export const JANELA_GATILHO_SEG = 300;
