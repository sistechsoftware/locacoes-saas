/**
 * Fila de e-mails: intenção de notificação gravada ANTES de qualquer envio
 * externo, com idempotência e histórico no mesmo registro.
 *
 * Por que uma fila e não `enviarEmail()` direto na action de reserva:
 *  1. a operação principal (salvar reserva, mudar status) nunca depende da
 *     rede nem do provedor — o e-mail é consequência, não etapa;
 *  2. o cron envia fora da request, com retry controlado e lease de execução;
 *  3. dedupe_key UNIQUE derruba duplicidade mesmo com cron concorrente ou
 *     reexecução — a mesma situação vira UMA linha, sempre;
 *  4. tudo fica auditável: pendente → enviado/falha, com tentativas e motivo.
 *
 * Toda decisão de ELEGIBILIDADE acontece AQUI, no momento do agendamento:
 * interruptor do tenant, endereço do cliente e integridade do tenant. O
 * resultado é gravado — inclusive quando o motivo é "não enviar" — para a tela
 * de histórico mostrar o que foi ignorado e por quê.
 */
import "server-only";
import { insert, one, run } from "./db";
import { settingsDaEmpresa } from "./settings";
import { emailValido, normalizarEmail } from "./identidade";
import {
  resolverConfigEmail,
  tipoLigado,
  type ConfigEmail,
  type TipoEmail,
} from "./email-notificacoes";
import { emailDoCliente } from "./email-dados";

export type StatusEmail =
  | "pendente"
  | "enviando"
  | "enviado"
  | "falha_temporaria"
  | "falha_definitiva"
  | "cancelado"
  | "ignorado";

/** Por que o registro existe mas NADA foi enviado. */
export type MotivoIgnorado =
  | "configuracao_desabilitada"
  | "sem_email"
  | "email_invalido"
  | "inconsistencia_tenant"
  | "origem_invalida"
  | "renderizacao_falhou"
  | "provedor_sem_configuracao";

export const MOTIVOS_TEXTO: Record<string, string> = {
  configuracao_desabilitada: "Notificação desativada nas configurações da empresa",
  sem_email: "Cliente sem e-mail cadastrado",
  email_invalido: "E-mail do cliente inválido",
  inconsistencia_tenant: "Inconsistência de empresa entre os registros (nada enviado)",
  origem_invalida: "Registro de origem inexistente ou de outra empresa",
  renderizacao_falhou: "Falha ao montar o conteúdo do e-mail",
  provedor_sem_configuracao: "Provedor de e-mail não configurado no Worker",
  lembrete_cancelado: "Origem cancelada ou reagendada antes do envio",
  tentativas_esgotadas: "Limite de tentativas atingido",
};

export async function configEmailDaEmpresa(companyId: number): Promise<ConfigEmail> {
  return resolverConfigEmail(await settingsDaEmpresa(companyId));
}

export type AgendaEmail = {
  companyId: number;
  type: TipoEmail;
  /** origem do disparo: reserva | operacao | fidelidade | configuracao */
  source: string;
  sourceId?: number | null;
  reservationId?: number | null;
  customerId?: number | null;
  /** endereço já conhecido (teste); senão vem do cliente pelo customerId */
  recipient?: string | null;
  context?: Record<string, unknown>;
  dedupeKey: string;
  /** epoch em que o envio pode acontecer; padrão = agora */
  scheduledAt?: number;
};

export type ResultadoAgendamento = {
  id: number | null;
  criado: boolean;
  status: StatusEmail;
  motivo: MotivoIgnorado | null;
};

const agora = () => Math.floor(Date.now() / 1000);

/**
 * Registra a intenção de enviar um e-mail.
 *
 * Nunca lança: devolve o que decidiu. A consistência dos dados é verificada
 * ANTES de gravar qualquer coisa destinável, e a inconsistência vira registro
 * de erro de integridade — sem envio, sem destinatário montado por engano.
 */
export async function agendarEmail(op: AgendaEmail): Promise<ResultadoAgendamento> {
  const cfg = await configEmailDaEmpresa(op.companyId);
  const ehTeste = op.type === "email_teste";

  // 1) interruptores do tenant (master + grupo + tipo)
  if (!ehTeste && !tipoLigado(cfg, op.type)) {
    return await gravar(op, { status: "ignorado", motivo: "configuracao_desabilitada", recipient: "" });
  }

  // 2) destinatário: do próprio endereço informado ou do cliente da origem
  let recipient = normalizarEmail(op.recipient ?? "");
  if (recipient) {
    if (!emailValido(recipient)) {
      return await gravar(op, { status: "ignorado", motivo: "email_invalido", recipient });
    }
  } else if (op.customerId) {
    const dono = await emailDoCliente(op.companyId, op.customerId);
    if (dono.inconsistente) {
      await registrarIntegridade(op, "cliente_de_outro_tenant");
      return await gravar(op, { status: "ignorado", motivo: "inconsistencia_tenant", recipient: "" });
    }
    if (!dono.email) {
      return await gravar(op, { status: "ignorado", motivo: "sem_email", recipient: "" });
    }
    recipient = dono.email;
  } else {
    return await gravar(op, { status: "ignorado", motivo: "origem_invalida", recipient: "" });
  }

  // 3) gravar a intenção — INSERT que não faz nada se a chave já existe
  return await gravar(op, { status: "pendente", motivo: null, recipient, scheduledAt: op.scheduledAt ?? agora() });
}

async function gravar(
  op: AgendaEmail,
  deciso: { status: StatusEmail; motivo: MotivoIgnorado | null; recipient: string; scheduledAt?: number },
): Promise<ResultadoAgendamento> {
  const quando = deciso.scheduledAt ?? agora();
  const ver = () =>
    one<{ id: number; status: StatusEmail; motivo: MotivoIgnorado | null }>(
      `SELECT id, status, motivo FROM email_notifications WHERE dedupe_key = ?`,
      [op.dedupeKey],
    );

  // 1) já existe = mesma situação virou linha antes (cron concorrente, reexecução
  //    de action, retry do insert): nada muda e nada é reenviado.
  const existente = await ver();
  if (existente) return { id: existente.id, criado: false, status: existente.status, motivo: existente.motivo };

  try {
    const id = await insert(
      `INSERT INTO email_notifications
         (company_id, type, source, source_id, reservation_id, customer_id, context, recipient,
          status, motivo, scheduled_at, next_attempt, created_at, updated_at, dedupe_key)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        op.companyId,
        op.type,
        op.source,
        op.sourceId ?? null,
        op.reservationId ?? null,
        op.customerId ?? null,
        JSON.stringify(op.context ?? {}),
        deciso.recipient,
        deciso.status,
        deciso.motivo,
        quando,
        quando,
        quando,
        quando,
        op.dedupeKey,
      ],
    );
    return { id, criado: true, status: deciso.status, motivo: deciso.motivo };
  } catch (e) {
    // corrida com outra escrita da MESMA chave: UNIQUE resolve, a linha é a
    // mesma e continua não sendo duplicada
    if (!/unique/i.test(String((e as Error)?.message ?? ""))) throw e;
    const depois = await ver();
    return {
      id: depois?.id ?? null,
      criado: false,
      status: depois?.status ?? deciso.status,
      motivo: depois?.motivo ?? deciso.motivo,
    };
  }
}

/**
 * Cancela notificações ainda não enviadas de uma origem.
 *
 * Chamado quando a reserva/operacao é cancelada ou reagendada: o lembrete
 * velho deixa de valer. Linhas já enviadas NUNCA são mexidas — o histórico do
 * que foi entregue é intocável.
 */
export async function cancelarPendentes(
  companyId: number,
  source: string,
  sourceId: number,
  motivo: string = "lembrete_cancelado",
  tipos?: readonly string[],
): Promise<number> {
  const filtro = tipos && tipos.length ? ` AND type IN (${tipos.map(() => "?").join(",")})` : "";
  const r = await run(
    `UPDATE email_notifications
        SET status = 'cancelado', motivo = ?, updated_at = ?
      WHERE company_id = ? AND source = ? AND source_id = ?
        AND status IN ('pendente','falha_temporaria','enviando')${filtro}`,
    [motivo, agora(), companyId, source, sourceId, ...(tipos ?? [])],
  );
  return Number(r.meta.changes ?? 0);
}

/**
 * Cancela notificações pendentes ligadas a uma RESERVA (inclui as das suas
 * operações): cancelar a reserva invalida o que estiver na fila para o futuro.
 */
export async function cancelarPendentesDaReserva(
  companyId: number,
  reservationId: number,
  motivo: string = "lembrete_cancelado",
  tipos?: readonly string[],
): Promise<number> {
  const filtro = tipos && tipos.length ? ` AND type IN (${tipos.map(() => "?").join(",")})` : "";
  const r = await run(
    `UPDATE email_notifications
        SET status = 'cancelado', motivo = ?, updated_at = ?
      WHERE company_id = ? AND reservation_id = ?
        AND status IN ('pendente','falha_temporaria','enviando')${filtro}`,
    [motivo, agora(), companyId, reservationId, ...(tipos ?? [])],
  );
  return Number(r.meta.changes ?? 0);
}

/**
 * Reagenda uma notificação elegível para nova tentativa Imediata (reprocesso
 * manual da tela de histórico). Só saem daqui linhas em falha: enviado,
 * cancelado e ignorado nunca são reenviados às cegas.
 */
export async function reprocessarEmail(companyId: number, id: number): Promise<{ ok: boolean; erro?: string }> {
  const linha = await one<{ id: number; status: StatusEmail; attempts: number }>(
    `SELECT id, status, attempts FROM email_notifications WHERE id = ? AND company_id = ?`,
    [id, companyId],
  );
  if (!linha) return { ok: false, erro: "Notificação não encontrada." };
  if (linha.status !== "falha_temporaria" && linha.status !== "falha_definitiva") {
    return { ok: false, erro: "Apenas notificações com falha podem ser reprocessadas." };
  }
  const r = await run(
    `UPDATE email_notifications
        SET status = 'pendente', next_attempt = ?, lease_until = 0, updated_at = ?
      WHERE id = ? AND company_id = ? AND status IN ('falha_temporaria','falha_definitiva')`,
    [agora(), agora(), id, companyId],
  );
  if (!Number(r.meta.changes ?? 0)) return { ok: false, erro: "A notificação mudou de estado; recarregue a página." };
  return { ok: true };
}

/**
 * Inconsistência entre tenants tratada como ERRO DE INTEGRIDADE visível:
 * vai para o diário de erros (/erros) com a empresa certa, nunca para o
 * destinatário. Fail-open: o diário nunca derruba o fluxo que chamou.
 */
export async function registrarIntegridade(op: { companyId: number; type: string; source: string; sourceId?: number | null }, motivo: string): Promise<void> {
  try {
    const { registrarErro } = await import("./error-log");
    await registrarErro({
      source: "api/log-erro",
      kind: "server",
      message: `E-mail não enviado por inconsistência de tenant: ${motivo}`,
      route: "email/agendamento",
      companyId: op.companyId,
      context: { type: op.type, source: op.source, sourceId: op.sourceId ?? null, motivo },
    });
  } catch {
    // diagnóstico nunca compete com o fluxo original
  }
}
