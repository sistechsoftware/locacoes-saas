/**
 * Renderização de uma linha da fila em conteúdo de e-mail.
 *
 * Separação de camadas: a fila guarda APENAS identificadores (context JSON) e
 * o conteúdo é montado NO MOMENTO DO ENVIO, a partir do banco. Consequências
 * desejadas:
 *  - alterar a reserva depois do agendamento faz o e-mail sair com os dados
 *    ATUAIS — nunca uma versão antiga congelada na fila;
 *  - nenhum dado pessoal fica parado em log ou em coluna de contexto;
 *  - a verificação de tenant acontece de novo aqui, imediatamente antes de
 *    endereçar a mensagem.
 */
import "server-only";
import { one } from "./db";
import { dateBR } from "./format";
import { resolverOperacao } from "./operacao";
import { settingsDaEmpresa } from "./settings";
import type { ConfigEmail, TipoEmail } from "./email-notificacoes";import {
  dadosDaOperacao,
  dadosDaReserva,
  dadosDeFidelidade,
  identidadeDaEmpresa,
  type Resultado,
} from "./email-dados";
import {
  emailAlteracaoOperacao,
  emailAlteracaoReserva,
  emailCancelamentoReserva,
  emailConfirmacaoReserva,
  emailFidelidadeConquista,
  emailFidelidadeProgresso,
  emailFidelidadeQuaseLa,
  emailFidelidadeUso,
  emailFidelidadeVencendo,
  emailLembreteOperacao,
  emailLembreteReserva,
  emailOperacaoAtrasada,
  emailOperacaoConcluida,
  emailSaidaOperacao,
  emailTeste,
  type EmailMontado,
} from "./email-templates";
import type { MotivoIgnorado } from "./email-queue";

export type LinhaEmail = {
  company_id: number;
  type: string;
  context: string;
  recipient: string;
};

export type Renderizacao = { ok: true; email: EmailMontado } | { ok: false; motivo: MotivoIgnorado };

/** "3 dias antes", "2 horas antes", "45 minutos antes". */
export function rotuloAntecedencia(minutos: number): string {
  const m = Math.max(0, Math.trunc(minutos));
  if (m === 0) return "no horário";
  if (m % 1440 === 0) {
    const d = m / 1440;
    return `${d} dia${d > 1 ? "s" : ""} antes`;
  }
  if (m % 60 === 0) {
    const h = m / 60;
    return `${h} hora${h > 1 ? "s" : ""} antes`;
  }
  return `${m} minutos antes`;
}

function lerContexto(bruto: string): Record<string, unknown> {
  try {
    const v = JSON.parse(bruto || "{}");
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const num = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0);

/**
 * Assunto sempre termina com o nome da LOCAÇÃO. Na caixa de entrada do
 * cliente fica de quem é a mensagem — quem aluga em duas empresas locadoras
 * nunca confunde. Se o template já cita o nome, não duplica.
 */
function comRemetente(email: EmailMontado, nome: string): EmailMontado {
  if (!nome || email.assunto.includes(nome)) return email;
  return { ...email, assunto: `${email.assunto} — ${nome}` };
}

/**
 * Monta o e-mail de uma linha. Em qualquer inconsistência devolve o motivo —
 * quem chama grava `ignorado`/`falha` e NÃO envia.
 */
export async function renderizarEmail(linha: LinhaEmail): Promise<Renderizacao> {
  const ident = await identidadeDaEmpresa(linha.company_id);
  const montado = await montarEmail(linha, ident);
  if (!montado.ok) return montado;
  return { ok: true, email: comRemetente(montado.email, ident.nome) };
}

async function montarEmail(linha: LinhaEmail, ident: Awaited<ReturnType<typeof identidadeDaEmpresa>>): Promise<Renderizacao> {
  const companyId = linha.company_id;
  const tipo = String(linha.type) as TipoEmail;
  const ctx = lerContexto(linha.context);
  const settings = await settingsDaEmpresa(companyId);
  const cfgOper = resolverOperacao(settings);

  switch (tipo) {
    /* ------------------------------ reservas ------------------------------ */
    case "reserva_confirmacao":
    case "reserva_lembrete":
    case "reserva_alteracao":
    case "reserva_cancelamento": {
      const r = await dadosDaReserva(companyId, num(ctx.reservation_id), cfgOper);
      if (!r.ok) return { ok: false, motivo: motivoDe(r) };
      if (tipo === "reserva_confirmacao") return { ok: true, email: emailConfirmacaoReserva(ident, r.dados) };
      if (tipo === "reserva_lembrete") {
        return { ok: true, email: emailLembreteReserva(ident, r.dados, rotuloAntecedencia(num(ctx.antecedencia))) };
      }
      if (tipo === "reserva_alteracao") {
        return { ok: true, email: emailAlteracaoReserva(ident, { ...r.dados, alteracoes: Array.isArray(ctx.alteracoes) ? (ctx.alteracoes as string[]) : [] }) };
      }
      return { ok: true, email: emailCancelamentoReserva(ident, r.dados) };
    }

    /* ----------------------------- operações ------------------------------ */
    case "operacao_lembrete":
    case "operacao_saida":
    case "operacao_concluida":
    case "operacao_alteracao":
    case "operacao_atrasada": {
      const o = await dadosDaOperacao(companyId, num(ctx.operation_id), cfgOper);
      if (!o.ok) return { ok: false, motivo: motivoDe(o) };
      if (tipo === "operacao_lembrete") {
        return { ok: true, email: emailLembreteOperacao(ident, o.dados, rotuloAntecedencia(num(ctx.antecedencia))) };
      }
      if (tipo === "operacao_saida") return { ok: true, email: emailSaidaOperacao(ident, o.dados) };
      if (tipo === "operacao_concluida") return { ok: true, email: emailOperacaoConcluida(ident, o.dados) };
      if (tipo === "operacao_atrasada") return { ok: true, email: emailOperacaoAtrasada(ident, o.dados) };
      return { ok: true, email: emailAlteracaoOperacao(ident, o.dados) };
    }

    /* ----------------------------- fidelidade ----------------------------- */
    case "fidelidade_progresso":
    case "fidelidade_quase_la":
    case "fidelidade_conquista":
    case "fidelidade_uso":
    case "fidelidade_vencendo": {
      const customerId = num(ctx.customer_id);
      const rewardId = ctx.reward_id ? num(ctx.reward_id) : null;
      const f = await dadosDeFidelidade(companyId, customerId, { rewardId });
      if (!f.ok) return { ok: false, motivo: motivoDe(f) };
      const premio = rewardId ? await carregarRecompensa(companyId, rewardId, f.dados) : null;
      const dados = {
        ...f.dados,
        beneficio: premio?.beneficio ?? f.dados.beneficio,
        quando: premio?.quando ?? "",
        condicoes: premio?.condicoes ?? f.dados.condicoes,
      };
      if (tipo === "fidelidade_progresso") return { ok: true, email: emailFidelidadeProgresso(ident, dados) };
      if (tipo === "fidelidade_quase_la") return { ok: true, email: emailFidelidadeQuaseLa(ident, dados) };
      if (tipo === "fidelidade_conquista") return { ok: true, email: emailFidelidadeConquista(ident, dados) };
      if (tipo === "fidelidade_uso") return { ok: true, email: emailFidelidadeUso(ident, dados) };
      return { ok: true, email: emailFidelidadeVencendo(ident, dados) };
    }

    /* ------------------------------- teste -------------------------------- */
    case "email_teste":
      return { ok: true, email: emailTeste(ident, linha.recipient) };

    default:
      return { ok: false, motivo: "origem_invalida" };
  }
}

/** Recompensa lida da MESMA empresa — benefício e prazo reais, nunca inventados. */
async function carregarRecompensa(
  companyId: number,
  rewardId: number,
  base: { unidade: string; unidadeSingular: string; condicoes: string[] },
) {
  const r = await one<{
    company_id: number;
    status: string;
    kit_quantity: number;
    expires_on: string | null;
    used_at: string | null;
    rule_validity_days: number;
  }>(
    `SELECT company_id, status, kit_quantity, expires_on, used_at, rule_validity_days
       FROM fidelity_rewards WHERE id = ?`,
    [rewardId],
  );
  if (!r || r.company_id !== companyId) return null;
  const qtd = Math.max(1, r.kit_quantity);
  return {
    beneficio: `${qtd} ${qtd === 1 ? base.unidadeSingular : base.unidade} grátis`,
    quando: r.expires_on ? dateBR(r.expires_on) : r.used_at ? dateBR(r.used_at) : "",
    condicoes: r.rule_validity_days > 0 ? [`validade de ${r.rule_validity_days} dias a partir da conquista`] : [],
  };
}

function motivoDe(r: Resultado<unknown>): MotivoIgnorado {
  if (!r.ok && r.motivo !== "nao_encontrado") return "inconsistencia_tenant";
  return "origem_invalida";
}
