/**
 * Agendador de e-mails: captura de lembretes + envio, com retry controlado.
 *
 * Roda no cron existente (custom-worker.ts, "* * * * *"), UMA vez por empresa
 * ativa dentro de runWithCompany — o mesmo desenho de push-scheduler e das
 * rotinas diárias. Cada empresa é isolada: uma que falhe não interrompe as
 * demais (o loop do worker captura por empresa).
 *
 * Confiabilidade:
 *  * captura por JANELA de 5 minutos no instante do gatilho (não varre o banco
 *    procurando "o que venceu ontem") + dedupe_key UNIQUE = idempotente mesmo
 *    com cron concorrente ou reinicialização;
 *  * envio com CLAIM (UPDATE condicional) e lease: dois isolates nunca mandam
 *    o mesmo e-mail, e um claim de isolate que morreu volta para a fila;
 *  * retry com backoff exponencial e teto de tentativas; falha definitiva fica
 *    registrada e pode ser reprocessada manualmente;
 *  * a validação de configuração/destinatário/tenant é REFEITA logo antes do
 *    envio — o que mudou depois do agendamento vale.
 *
 * Nada disso roda dentro da action que salva a reserva: a fila é gravada lá e
 * o envio acontece aqui, sempre fora da operação crítica.
 */
import { enviarEmailDetalhado, type EmailMensagem, type ResultadoEnvio } from "./email";
import { cronCompanyId } from "./db";
import { marcarConsulta } from "./perf";
import { agendarEmail, configEmailDaEmpresa, registrarIntegridade } from "./email-queue";
import { renderizarEmail } from "./email-render";
import { antecedenciasDe, tipoLigado, type ConfigEmail, type TipoEmail } from "./email-notificacoes";
import { agendarLembrete, epochDeWallClock, fusoSeguro, JANELA_GATILHO_SEG, sufixoFuso, wallClockIso } from "./email-tempo";
import { emailDoCliente, identidadeDaEmpresa } from "./email-dados";

type Envio = (msg: EmailMensagem) => Promise<ResultadoEnvio>;

export type ResultadoScheduler = {
  capturados: number;
  enviados: number;
  falhas: number;
  ignorados: number;
  cancelados: number;
};

/** Tentativas antes de marcar falha definitiva (backoff 1min, 2, 4, 8…). */
export const MAX_TENTATIVAS = 5;
const BACKOFF_BASE = 60;
const BACKOFF_MAX = 3600;
/** Claim: quanto tempo o isolate tem para terminar antes de ser recuperado. */
const LEASE_SEG = 120;
/** Lote por tick — mantém cada execução curta mesmo em empresa grande. */
const LOTE = 5;

async function rows<T>(db: D1Database, sql: string, params: (string | number | null)[] = []): Promise<T[]> {
  marcarConsulta();
  return (await db.prepare(sql).bind(...params).all<T>()).results ?? [];
}

async function execute(db: D1Database, sql: string, params: (string | number | null)[] = []) {
  marcarConsulta();
  return db.prepare(sql).bind(...params).run();
}

/** Status que permitem lembrete de reserva: confirmada em diante, nunca cancelada/orçamento/pré-reserva. */
const STATUS_RESERVA_LEMBRETE = "('confirmada','entregue','em_uso','aguardando_retirada')";
/** Operação ainda em aberto — concluída/cancelada não gera lembrete. */
const STATUS_OPERACAO_ABERTA = "('pendente','confirmada','em_rota','no_local','reagendada')";

/* ------------------------------------------------------------------ */
/* Captura de lembretes                                                */
/* ------------------------------------------------------------------ */

/** Âncora da reserva: data do evento + horário (evento, início da locação ou meio-dia). */
const ANCORA_RESERVA = `r.event_date || 'T' || COALESCE(
  NULLIF(CASE WHEN length(trim(COALESCE(r.event_time,''))) = 4 THEN '0' || trim(r.event_time)
              ELSE substr(trim(COALESCE(r.event_time,'')),1,5) END, ''),
  NULLIF(substr(COALESCE(r.delivery_at,''),12,5), ''),
  '12:00')`;

async function capturarLembretesReserva(
  db: D1Database,
  companyId: number,
  cfg: ConfigEmail,
  now: number,
): Promise<number> {
  if (!cfg.ativo || !cfg.grupos.reservas || !cfg.tipos.reserva_lembrete) return 0;
  const offsets = antecedenciasDe(cfg, "reserva_lembrete");
  if (!offsets.length) return 0;

  const tz = fusoSeguro(cfg.fuso);
  const suf = sufixoFuso(tz, now * 1000);
  const menorSeg = Math.min(...offsets) * 60;
  const maiorSeg = Math.max(...offsets) * 60;
  // janela de datas que PODE conter um gatilho dentro de [now-5min, now]
  const de = wallClockIso(now + menorSeg - JANELA_GATILHO_SEG, tz).slice(0, 10);
  const ate = wallClockIso(now + maiorSeg + JANELA_GATILHO_SEG, tz).slice(0, 10);

  const linhas = await rows<{
    id: number;
    customer_id: number;
    ancora: string;
    off: number;
  }>(
    db,
    `SELECT r.id, r.customer_id, ${ANCORA_RESERVA} AS ancora, j.value AS off
       FROM reservations r CROSS JOIN json_each(?) j
      WHERE r.company_id = ?
        AND r.status IN ${STATUS_RESERVA_LEMBRETE}
        AND r.is_demo = 0
        AND r.event_date >= ? AND r.event_date <= ?
        AND (unixepoch(${ANCORA_RESERVA} || ':00' || ?) - j.value * 60) BETWEEN ? AND ?
      ORDER BY r.id
      LIMIT 30`,
    [JSON.stringify(offsets), companyId, de, ate, suf, now - JANELA_GATILHO_SEG, now],
  );

  let n = 0;
  for (const l of linhas) {
    const gatilho = epochDeWallClock(l.ancora, tz) - l.off * 60;
    if (gatilho <= 0) continue;
    const quando = agendarLembrete(gatilho, cfg);
    const r = await agendarEmail({
      companyId,
      type: "reserva_lembrete",
      source: "reserva",
      sourceId: l.id,
      reservationId: l.id,
      customerId: l.customer_id,
      context: { reservation_id: l.id, antecedencia: l.off },
      dedupeKey: `c${companyId}:reserva_lembrete:${l.id}:${l.off}:${gatilho}`,
      scheduledAt: quando,
    });
    if (r.criado) n++;
  }
  return n;
}

async function capturarLembretesOperacao(
  db: D1Database,
  companyId: number,
  cfg: ConfigEmail,
  now: number,
): Promise<number> {
  if (!cfg.ativo || !cfg.grupos.operacoes || !cfg.tipos.operacao_lembrete) return 0;
  const offsets = antecedenciasDe(cfg, "operacao_lembrete");
  if (!offsets.length) return 0;

  const tz = fusoSeguro(cfg.fuso);
  const suf = sufixoFuso(tz, now * 1000);
  const menorSeg = Math.min(...offsets) * 60;
  const maiorSeg = Math.max(...offsets) * 60;
  const de = wallClockIso(now + menorSeg - JANELA_GATILHO_SEG, tz);
  const ate = wallClockIso(now + maiorSeg + JANELA_GATILHO_SEG, tz);

  const linhas = await rows<{ id: number; customer_id: number | null; scheduled_at: string; off: number }>(
    db,
    `SELECT o.id, o.scheduled_at, rr.customer_id AS customer_id, j.value AS off
       FROM operations o
       CROSS JOIN json_each(?) j
       LEFT JOIN reservations rr ON rr.id = o.reservation_id
      WHERE o.company_id = ?
        AND o.status IN ${STATUS_OPERACAO_ABERTA}
        AND o.scheduled_at >= ? AND o.scheduled_at <= ?
        AND (unixepoch(replace(substr(o.scheduled_at,1,16),' ','T') || ':00' || ?) - j.value * 60) BETWEEN ? AND ?
      ORDER BY o.id
      LIMIT 30`,
    [JSON.stringify(offsets), companyId, de, ate, suf, now - JANELA_GATILHO_SEG, now],
  );

  let n = 0;
  for (const l of linhas) {
    const gatilho = epochDeWallClock(l.scheduled_at, tz) - l.off * 60;
    if (gatilho <= 0) continue;
    const quando = agendarLembrete(gatilho, cfg);
    const r = await agendarEmail({
      companyId,
      type: "operacao_lembrete",
      source: "operacao",
      sourceId: l.id,
      reservationId: null,
      customerId: l.customer_id ?? null,
      context: { operation_id: l.id, antecedencia: l.off },
      dedupeKey: `c${companyId}:operacao_lembrete:${l.id}:${l.off}:${gatilho}`,
      scheduledAt: quando,
    });
    if (r.criado) n++;
  }
  return n;
}

/**
 * Operações que já passaram da data prevista e continuam em aberto.
 *
 * Uma vez por dia (a partir da hora de envio), com marca em scheduler_state —
 * o mesmo padrão das rotinas diárias. A chave de dedupe inclui o dia, então uma
 * mesma operação gera UM aviso por dia útil de atraso, não um por minuto.
 */
async function capturarAtrasadas(db: D1Database, companyId: number, cfg: ConfigEmail, now: number): Promise<number> {
  if (!cfg.ativo || !cfg.grupos.operacoes || !cfg.tipos.operacao_atrasada) return 0;
  const tz = fusoSeguro(cfg.fuso);
  const local = wallClockIso(now, tz);
  const hoje = local.slice(0, 10);
  if (local.slice(11, 16) < cfg.horaEnvio) return 0;

  const marca = `email_atrasadas:c${companyId}:${hoje}`;
  marcarConsulta();
  const ja = await db.prepare(`SELECT value FROM scheduler_state WHERE key = ?`).bind(marca).first<{ value: string }>();
  if (ja?.value === "hoje") return 0;

  const limite = wallClockIso(now - 30 * 86400, tz).slice(0, 10);
  const linhas = await rows<{ id: number; customer_id: number | null; scheduled_at: string }>(
    db,
    `SELECT o.id, o.scheduled_at, rr.customer_id AS customer_id
       FROM operations o
       LEFT JOIN reservations rr ON rr.id = o.reservation_id
      WHERE o.company_id = ?
        AND o.status IN ${STATUS_OPERACAO_ABERTA}
        AND substr(o.scheduled_at,1,10) < ?
        AND substr(o.scheduled_at,1,10) >= ?
        AND o.scheduled_at >= ?
      ORDER BY o.scheduled_at DESC
      LIMIT 50`,
    [companyId, hoje, limite, limite],
  );

  let n = 0;
  for (const l of linhas) {
    const r = await agendarEmail({
      companyId,
      type: "operacao_atrasada",
      source: "operacao",
      sourceId: l.id,
      customerId: l.customer_id ?? null,
      context: { operation_id: l.id },
      dedupeKey: `c${companyId}:operacao_atrasada:${l.id}:${hoje}`,
      scheduledAt: now,
    });
    if (r.criado) n++;
  }

  await execute(
    db,
    `INSERT INTO scheduler_state(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [marca, "hoje"],
  );
  return n;
}

/* ------------------------------------------------------------------ */
/* Envio                                                               */
/* ------------------------------------------------------------------ */

type LinhaFila = {
  id: number;
  company_id: number;
  type: string;
  customer_id: number | null;
  recipient: string;
  context: string;
  attempts: number;
};

/**
 * Processa os vencidos da fila desta empresa. Devolve as contagens para o
 * log do cron (uma linha por empresa, como as demais rotinas).
 */
async function processarFila(db: D1Database, companyId: number, now: number, enviar: Envio): Promise<ResultadoScheduler> {
  const out: ResultadoScheduler = { capturados: 0, enviados: 0, falhas: 0, ignorados: 0, cancelados: 0 };

  // claims de um isolate que morreu voltam para a fila (lease vencido)
  await execute(
    db,
    `UPDATE email_notifications SET status = 'falha_temporaria', next_attempt = ?, lease_until = 0, updated_at = ?
      WHERE company_id = ? AND status = 'enviando' AND lease_until < ?`,
    [now, now, companyId, now],
  );

  const pendentes = await rows<LinhaFila>(
    db,
    `SELECT id, company_id, type, customer_id, recipient, context, attempts
       FROM email_notifications
      WHERE company_id = ?
        AND status IN ('pendente','falha_temporaria')
        AND scheduled_at <= ? AND next_attempt <= ?
      ORDER BY scheduled_at, id
      LIMIT ${LOTE}`,
    [companyId, now, now],
  );

  for (const linha of pendentes) {
    // CLAIM atômico: só um processo transita para 'enviando'
    const claim = await execute(
      db,
      `UPDATE email_notifications
          SET status = 'enviando', lease_until = ?, attempts = attempts + 1, updated_at = ?
        WHERE id = ? AND company_id = ? AND status IN ('pendente','falha_temporaria') AND next_attempt <= ?`,
      [now + LEASE_SEG, now, linha.id, companyId, now],
    );
    if (!Number(claim.meta?.changes ?? 0)) continue;
    const tentativa = linha.attempts + 1;
    out.enviados += await concluir(db, linha, tentativa, companyId, now, enviar, out);
  }
  return out;
}

/**
 * Valida, renderiza e envia UMA linha já reivindicada. Toda saída registra o
 * estado final — nunca fica presa em 'enviando'.
 */
async function concluir(
  db: D1Database,
  linha: LinhaFila,
  tentativa: number,
  companyId: number,
  now: number,
  enviar: Envio,
  out: ResultadoScheduler,
): Promise<number> {
  const cfg = await configEmailDaEmpresa(companyId);

  // 1) interruptores podem ter mudado desde o agendamento
  if (!tipoLigado(cfg, linha.type as TipoEmail)) {
    await finalizar(db, linha.id, { status: "ignorado", motivo: "configuracao_desabilitada" }, now);
    out.ignorados++;
    return 0;
  }

  // 2) destinatário revalidado na origem (cliente pode ter mudado ou saiu da empresa)
  let destino = linha.recipient;
  if (linha.customer_id) {
    const dono = await emailDoCliente(companyId, linha.customer_id);
    if (dono.inconsistente) {
      await registrarIntegridade({ companyId, type: linha.type, source: "email", sourceId: linha.id }, "cliente_de_outro_tenant");
      await finalizar(db, linha.id, { status: "ignorado", motivo: "inconsistencia_tenant" }, now);
      out.ignorados++;
      return 0;
    }
    if (!dono.email) {
      await finalizar(db, linha.id, { status: "ignorado", motivo: "sem_email" }, now);
      out.ignorados++;
      return 0;
    }
    destino = dono.email;
  }

  // 3) conteúdo montado a partir do banco AGORA (dados atuais, tenant certo)
  const rend = await renderizarEmail({ company_id: companyId, type: linha.type, context: linha.context, recipient: destino });
  if (!rend.ok) {
    if (rend.motivo === "inconsistencia_tenant") {
      await registrarIntegridade({ companyId, type: linha.type, source: "email", sourceId: linha.id }, rend.motivo);
    }
    await finalizar(db, linha.id, { status: "ignorado", motivo: rend.motivo }, now);
    out.ignorados++;
    return 0;
  }

  const ident = await identidadeDaEmpresa(companyId);
  let resultado: ResultadoEnvio;
  try {
    resultado = await enviar({
      to: destino,
      subject: rend.email.assunto,
      html: rend.email.html,
      text: rend.email.texto,
      deNome: ident.nome,
    });
  } catch (e) {
    resultado = { ok: false, id: null, status: null, temporaria: true, erro: String((e as Error)?.message ?? e).slice(0, 160), motivoConfig: null };
  }

  if (resultado.ok) {
    await execute(
      db,
      `UPDATE email_notifications
          SET status = 'enviado', recipient = ?, subject = ?, provider_id = ?, sent_at = ?,
              attempts = ?, last_error = NULL, lease_until = 0, motivo = NULL, updated_at = ?
        WHERE id = ? AND company_id = ?`,
      [destino, rend.email.assunto, resultado.id, now, tentativa, now, linha.id, companyId],
    );
    out.enviados++;
    return 1;
  }

  const causa = resultado.motivoConfig ?? resultado.erro ?? "falha desconhecida";
  const esgotou = tentativa >= MAX_TENTATIVAS;
  const efemera = resultado.temporaria && !esgotou;
  const backoff = Math.min(BACKOFF_MAX, BACKOFF_BASE * Math.pow(2, tentativa - 1));
  await execute(
    db,
    `UPDATE email_notifications
        SET status = ?, subject = ?, last_error = ?, motivo = ?, next_attempt = ?, lease_until = 0, updated_at = ?
      WHERE id = ? AND company_id = ?`,
    [
      efemera ? "falha_temporaria" : "falha_definitiva",
      rend.email.assunto,
      String(causa).slice(0, 300),
      esgotou ? "tentativas_esgotadas" : null,
      now + backoff,
      now,
      linha.id,
      companyId,
    ],
  );
  out.falhas++;
  return 0;
}

async function finalizar(
  db: D1Database,
  id: number,
  deciso: { status: "ignorado" | "cancelado"; motivo: string },
  now: number,
): Promise<void> {
  await execute(
    db,
    `UPDATE email_notifications SET status = ?, motivo = ?, lease_until = 0, updated_at = ?
      WHERE id = ? AND status = 'enviando'`,
    [deciso.status, deciso.motivo, now, id],
  );
}

/* ------------------------------------------------------------------ */
/* Ponto de entrada (cron)                                             */
/* ------------------------------------------------------------------ */

/**
 * Rotina de e-mail da empresa do contexto atual (runWithCompany).
 * Captura lembretes e processa a fila; nunca lança — a falha de uma empresa
 * é reportada pelo loop do worker, sem derrubar as demais.
 */
export async function runEmailScheduler(
  db: D1Database,
  now = Math.floor(Date.now() / 1000),
  enviar: Envio = enviarEmailDetalhado,
): Promise<ResultadoScheduler> {
  const companyId = await cronCompanyId();
  const cfg = await configEmailDaEmpresa(companyId);

  const capturados =
    (await capturarLembretesReserva(db, companyId, cfg, now)) +
    (await capturarLembretesOperacao(db, companyId, cfg, now)) +
    (await capturarAtrasadas(db, companyId, cfg, now));

  const proc = await processarFila(db, companyId, now, enviar);
  return { ...proc, capturados };
}

/** Exportado para testes: a mesma captura, sem passar pelo cron. */
export const __internos = { capturarLembretesReserva, capturarLembretesOperacao, capturarAtrasadas, processarFila };
