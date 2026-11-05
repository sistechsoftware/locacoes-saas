/**
 * Pré-visualização de modelo de e-mail — camada SERVER, SOMENTE LEITURA.
 *
 * Monta o e-mail exatamente como ele sairia (cabeçalho com a logo da empresa,
 * corpo com as variáveis substituídas e rodapé), sem enfileirar nada e sem
 * disparar nenhuma ação operacional. Os dados vêm de uma reserva ESCOLHIDA da
 * própria empresa (quando o administrador escolhe uma) ou da amostra fictícia.
 */
import "server-only";
import type { ModeloEmail } from "./email-modelos";
import { dadosDaReserva, identidadeDaEmpresa, operacaoConfigDaEmpresa } from "./email-dados";
import { amostraFidelidade, amostraOperacao, amostraReserva } from "./email-amostra";
import {
  personalizacao,
  variaveisDeFidelidade,
  variaveisDeOperacao,
  variaveisDeReserva,
} from "./email-variaveis";
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
import type { TipoEmail } from "./email-notificacoes";

export type OpcoesPrevia = {
  companyId: number;
  tipo: TipoEmail;
  modelo?: ModeloEmail | null;
  /** Reserva real da empresa para a prévia; ausente = amostra fictícia. */
  reservaId?: number | null;
  antecedencia?: string;
  /** Origem pública para a logo; ausente = PUBLIC_URL do ambiente. */
  baseUrl?: string;
};

/** HTML pronto para o iframe da tela (nunca lança para a UI). */
export async function renderizarPreviaModelo(opts: OpcoesPrevia): Promise<EmailMontado> {
  const ident = await identidadeDaEmpresa(opts.companyId, { baseUrl: opts.baseUrl });
  const cfg = await operacaoConfigDaEmpresa(opts.companyId);
  const modelo = opts.modelo ?? null;

  if (opts.tipo.startsWith("fidelidade_")) {
    const dados = amostraFidelidade();
    const perso = personalizacao(modelo, variaveisDeFidelidade(ident, dados));
    switch (opts.tipo) {
      case "fidelidade_progresso":
        return emailFidelidadeProgresso(ident, dados, perso);
      case "fidelidade_quase_la":
        return emailFidelidadeQuaseLa(ident, dados, perso);
      case "fidelidade_conquista":
        return emailFidelidadeConquista(ident, dados, perso);
      case "fidelidade_uso":
        return emailFidelidadeUso(ident, dados, perso);
      default:
        return emailFidelidadeVencendo(ident, dados, perso);
    }
  }

  if (opts.tipo.startsWith("operacao_")) {
    const dados = amostraOperacao();
    const perso = personalizacao(modelo, variaveisDeOperacao(ident, dados));
    switch (opts.tipo) {
      case "operacao_lembrete":
        return emailLembreteOperacao(ident, dados, opts.antecedencia ?? "1 dia antes", perso);
      case "operacao_saida":
        return emailSaidaOperacao(ident, dados, perso);
      case "operacao_concluida":
        return emailOperacaoConcluida(ident, dados, perso);
      case "operacao_atrasada":
        return emailOperacaoAtrasada(ident, dados, perso);
      default:
        return emailAlteracaoOperacao(ident, dados, perso);
    }
  }

  // Reservas (e o teste): reserva escolhida quando houver, senão a amostra.
  let dados = amostraReserva();
  if (opts.reservaId) {
    const r = await dadosDaReserva(opts.companyId, opts.reservaId, cfg, { valores: true });
    if (r.ok) dados = r.dados;
  }
  const perso = personalizacao(modelo, variaveisDeReserva(ident, dados));

  switch (opts.tipo) {
    case "reserva_confirmacao":
      return emailConfirmacaoReserva(ident, dados, perso);
    case "reserva_lembrete":
      return emailLembreteReserva(ident, dados, opts.antecedencia ?? "1 dia antes", perso);
    case "reserva_alteracao":
      return emailAlteracaoReserva(ident, dados, perso);
    case "reserva_cancelamento":
      return emailCancelamentoReserva(ident, dados, perso);
    default:
      return emailTeste(ident, "cliente@exemplo.com", perso);
  }
}
