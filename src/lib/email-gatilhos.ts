/**
 * Gatilhos de negócio que enfileiram e-mails — a PONTE entre o sistema que já
 * existe (reservas, operações, fidelidade) e a fila de notificações.
 *
 * Regras destes gatilhos:
 *  * FAIL-OPEN: gravar a intenção nunca lança para a action — o try/catch é
 *    interno; se falhar, a reserva continua salva e a causa vai ao console;
 *  * AGUARDADOS pela action (não fire-and-forget): a escrita é só um INSERT
 *    local, barato e síncrono com o fim da request — soltar a promise no Workers
 *    poderia perder a intenção quando a resposta termina;
 *  * SEM ENVIO externo aqui: só INSERT na fila. O provedor é falado
 *    exclusivamente no cron (email-scheduler), fora da operação crítica;
 *  * TENANT vem do registro de origem: a validação completa acontece em
 *    email-queue/email-dados, antes de qualquer destinatário;
 *  * IDEMPOTÊNCIA por dedupe_key determinística derivada do ESTADO (não do
 *    relógio): repetir a mesma transição não gera segundo e-mail;
 *  * CANCELAMENTO antes da nova intenção: lembrete velho nunca sobrevive a
 *    reagendamento ou cancelamento.
 */
import "server-only";
import { agendarEmail, cancelarPendentes, cancelarPendentesDaReserva, type AgendaEmail } from "./email-queue";
import { descreverAlteracoesReserva, operacaoConfigDaEmpresa, reservaParaEmail } from "./email-dados";
import { tenantCompanyId } from "./tenant";
import { chaveEvento, type EventoFidelidade } from "./fidelidade";

const TIPOS_LEMBRETE_RESERVA = ["reserva_lembrete"] as const;
const TIPOS_LEMBRETE_OPERACAO = ["operacao_lembrete", "operacao_atrasada"] as const;

/** Executa sem nunca lançar: o e-mail é consequência, não etapa da operação. */
async function failOpen(nome: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    console.error(`[email] gatilho ${nome} falhou (fail-open):`, (e as Error)?.message ?? e);
  }
}

/* ------------------------------------------------------------------ */
/* Reservas                                                            */
/* ------------------------------------------------------------------ */

/** Reserva criada já confirmada: vale o aviso de confirmação. */
export function reservaCriada(companyId: number, reservationId: number, status: string): Promise<void> {
  if (status !== "confirmada") return Promise.resolve();
  return failOpen("reservaCriada", async () => {
    const ctx = await reservaParaEmail(companyId, reservationId);
    if (!ctx.ok) return;
    await agendarEmail({
      companyId,
      type: "reserva_confirmacao",
      source: "reserva",
      sourceId: reservationId,
      reservationId,
      customerId: ctx.dados.linha.customer_id,
      context: { reservation_id: reservationId },
      dedupeKey: `c${companyId}:reserva_confirmacao:${reservationId}:${status}`,
    });
  });
}

export type EstadoReserva = {
  event_date?: string | null;
  event_time?: string | null;
  delivery_at?: string | null;
  pickup_at?: string | null;
  status?: string | null;
};

const CAMPOS_DE_DATA = ["event_date", "event_time", "delivery_at", "pickup_at"] as const;

function mudou(algo: Record<string, unknown>, campo: string, novo: Record<string, unknown>): boolean {
  return String(algo[campo] ?? "") !== String(novo[campo] ?? "");
}

/**
 * Reserva salva com alteração.
 *
 * Data/horário alterado → os lembretes da data ANTIGA saem da fila (a chave de
 * dedupe inclui o gatilho, então o cron recria os da data nova sozinho) e o
 * aviso de alteração sai com a lista do que mudou. Mudança de status também
 * avisa. Alterar observação ou itens não gera e-mail: o cliente não precisa de
 * um aviso a cada salvamento.
 */
export function reservaAlterada(
  companyId: number,
  reservationId: number,
  anterior: EstadoReserva,
  nova: EstadoReserva,
): Promise<void> {
  const mudouData = CAMPOS_DE_DATA.some((c) => mudou(anterior, c, nova));
  const mudouStatus = String(anterior.status ?? "") !== String(nova.status ?? "");
  if (!mudouData && !mudouStatus) return Promise.resolve();

  return failOpen("reservaAlterada", async () => {
    if (mudouData) {
      // lembretes da janela anterior deixam de valer (reserva e suas operações)
      await cancelarPendentes(companyId, "reserva", reservationId, "lembrete_cancelado", TIPOS_LEMBRETE_RESERVA);
      await cancelarPendentesDaReserva(companyId, reservationId, "lembrete_cancelado", TIPOS_LEMBRETE_OPERACAO);
    }

    const ctx = await reservaParaEmail(companyId, reservationId);
    if (!ctx.ok) return;
    const cfg = await operacaoConfigDaEmpresa(companyId);
    const alteracoes = descreverAlteracoesReserva(anterior, nova, cfg);
    const estado = [nova.event_date, nova.event_time, nova.delivery_at, nova.pickup_at, nova.status]
      .map((v) => String(v ?? ""))
      .join("~");
    const op: AgendaEmail = {
      companyId,
      type: "reserva_alteracao",
      source: "reserva",
      sourceId: reservationId,
      reservationId,
      customerId: ctx.dados.linha.customer_id,
      context: { reservation_id: reservationId, alteracoes },
      dedupeKey: `c${companyId}:reserva_alteracao:${reservationId}:${estado}`,
    };
    await agendarEmail(op);
  });
}

/**
 * Reserva cancelada (ou excluída): primeiro sai TUDO que estava na fila para o
 * futuro, depois o aviso de cancelamento. A ordem importa — cancelar depois
 * derrubaria o próprio aviso recém-enfileirado.
 */
export function reservaCancelada(companyId: number, reservationId: number, gerarAviso = true): Promise<void> {
  return failOpen("reservaCancelada", async () => {
    await cancelarPendentes(companyId, "reserva", reservationId);
    await cancelarPendentesDaReserva(companyId, reservationId);
    if (!gerarAviso) return; // exclusão definitiva não gera aviso para o cliente
    const ctx = await reservaParaEmail(companyId, reservationId);
    if (!ctx.ok) return;
    await agendarEmail({
      companyId,
      type: "reserva_cancelamento",
      source: "reserva",
      sourceId: reservationId,
      reservationId,
      customerId: ctx.dados.linha.customer_id,
      context: { reservation_id: reservationId },
      dedupeKey: `c${companyId}:reserva_cancelamento:${reservationId}:${String(ctx.dados.linha.status)}`,
    });
  });
}

/* ------------------------------------------------------------------ */
/* Operações                                                           */
/* ------------------------------------------------------------------ */

/**
 * Transição de status da operação — só quando HOUVE transição: repetir o mesmo
 * status não enfileira nada, então não há e-mail idêntico em série.
 */
export function operacaoStatus(
  companyId: number,
  operationId: number,
  de: string,
  para: string,
  reservationId: number | null,
): Promise<void> {
  if (!para || de === para) return Promise.resolve();
  const tipo =
    para === "em_rota" ? "operacao_saida" : para === "concluida" ? "operacao_concluida" : para === "cancelada" ? "operacao_alteracao" : null;
  if (!tipo) return Promise.resolve();

  return failOpen("operacaoStatus", async () => {
    if (para === "cancelada") {
      await cancelarPendentes(companyId, "operacao", operationId, "lembrete_cancelado", TIPOS_LEMBRETE_OPERACAO);
    }
    await agendarEmail({
      companyId,
      type: tipo,
      source: "operacao",
      sourceId: operationId,
      reservationId,
      context: { operation_id: operationId, de, para },
      dedupeKey: `c${companyId}:${tipo}:${operationId}:${para}`,
    });
  });
}

/** Operação reagendada: lembretes do horário antigo saem, o aviso de alteração entra. */
export function operacaoAlterada(
  companyId: number,
  operationId: number,
  anterior: { scheduled_at?: string | null; status?: string | null },
  nova: { scheduled_at?: string | null; status?: string | null },
  reservationId: number | null,
): Promise<void> {
  if (String(anterior.scheduled_at ?? "") === String(nova.scheduled_at ?? "")) return Promise.resolve();

  return failOpen("operacaoAlterada", async () => {
    await cancelarPendentes(companyId, "operacao", operationId, "lembrete_cancelado", TIPOS_LEMBRETE_OPERACAO);
    await agendarEmail({
      companyId,
      type: "operacao_alteracao",
      source: "operacao",
      sourceId: operationId,
      reservationId,
      context: { operation_id: operationId, de: anterior.scheduled_at, para: nova.scheduled_at },
      dedupeKey: `c${companyId}:operacao_alteracao:${operationId}:${String(nova.scheduled_at ?? "")}`,
    });
  });
}

/** Cancelamento explícito da operação: limpa o futuro e avisa o cliente. */
export function operacaoCancelada(companyId: number, operationId: number, reservationId: number | null): Promise<void> {
  return failOpen("operacaoCancelada", async () => {
    await cancelarPendentes(companyId, "operacao", operationId, "lembrete_cancelado", TIPOS_LEMBRETE_OPERACAO);
    await agendarEmail({
      companyId,
      type: "operacao_alteracao",
      source: "operacao",
      sourceId: operationId,
      reservationId,
      context: { operation_id: operationId, de: "", para: "cancelada" },
      dedupeKey: `c${companyId}:operacao_alteracao:${operationId}:cancelada`,
    });
  });
}

/* ------------------------------------------------------------------ */
/* Fidelidade                                                          */
/* ------------------------------------------------------------------ */

const TIPO_DO_EVENTO: Partial<Record<EventoFidelidade, AgendaEmail["type"]>> = {
  progresso: "fidelidade_progresso",
  quase_la: "fidelidade_quase_la",
  conquista: "fidelidade_conquista",
  uso: "fidelidade_uso",
  vencendo: "fidelidade_vencendo",
};

/**
 * Avisa o cliente sobre um evento do programa de fidelidade.
 *
 * Chamado pelo MESMO ponto que prepara a mensagem do WhatsApp (prepararMensagem),
 * mas com interruptor PRÓPRIO: desligar o aviso por WhatsApp não desliga o
 * e-mail, e vice-versa. A chave reaproveita `chaveEvento`, então avançar duas
 * vezes no mesmo ciclo, reprocesar a rotina ou rodar dois crons ao mesmo tempo
 * não geram dois e-mails.
 *
 * A empresa vem do DONO do evento (customers.company_id) — se ela divergir do
 * contexto que processava, email-queue classifica como inconsistência e não
 * envia.
 */
export function fidelidadeAviso(
  evento: EventoFidelidade,
  customerId: number,
  referencia: number | string,
  rewardId?: number | null,
): Promise<void> {
  const tipo = TIPO_DO_EVENTO[evento];
  if (!tipo) return Promise.resolve();
  return failOpen("fidelidadeAviso", async () => {
    const companyId = await tenantCompanyId();
    await agendarEmail({
      companyId,
      type: tipo,
      source: "fidelidade",
      sourceId: customerId,
      customerId,
      context: { customer_id: customerId, reward_id: rewardId ?? null, evento },
      dedupeKey: `c${companyId}:${chaveEvento(evento, customerId, referencia)}`,
    });
  });
}
