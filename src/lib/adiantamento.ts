/**
 * Adiantamento de reserva: regras puras.
 *
 * Um adiantamento nao e uma entidade financeira nova — e um caso especifico do
 * que ja existe: dinheiro que entra imediatamente vai para `payments` (o
 * mesmo livro de qualquer pagamento de reserva); dinheiro combinado para uma
 * data futura vira uma previsao em `financial_entries` (o mesmo livro de
 * qualquer parcela a receber), marcada com category='Adiantamento' para se
 * distinguir de um parcelamento do total. `situacaoParcela`, de financeiro.ts,
 * ja resolve aberta/vencida/quitada/cancelada; aqui so troca o rotulo para a
 * linguagem do adiantamento.
 *
 * Nao acessa banco, para a regra ser testavel sozinha.
 */
import { situacaoParcela, type SituacaoParcela } from "./financeiro";

export type SituacaoAdiantamento = "agendado" | "atrasado" | "recebido" | "cancelado";

const ROTULO: Record<SituacaoParcela, SituacaoAdiantamento> = {
  aberta: "agendado",
  vencida: "atrasado",
  parcial: "agendado", // um adiantamento parcialmente recebido ainda esta em aberto
  quitada: "recebido",
  cancelada: "cancelado",
};

export function situacaoAdiantamento(
  entry: { amount_cents: number; due_date: string; status?: string },
  liquidadoCents: number,
  hoje: string,
): SituacaoAdiantamento {
  return ROTULO[situacaoParcela(entry, liquidadoCents, hoje)];
}

/**
 * O adiantamento pode ser no maximo o que falta da reserva.
 *
 * O saldo considerado e o que ainda nao virou dinheiro nem promessa: total
 * menos o que ja foi recebido menos o que ja esta agendado em outro
 * adiantamento aberto, para nao prometer duas vezes o mesmo real.
 */
export function validarValorAdiantamento(amountCents: number, saldoDisponivelCents: number): string | null {
  if (!Number.isFinite(amountCents) || amountCents <= 0) return "Informe um valor de adiantamento maior que zero.";
  if (amountCents > saldoDisponivelCents) {
    return `O adiantamento não pode passar do saldo disponível da reserva (${(saldoDisponivelCents / 100).toFixed(2).replace(".", ",")}).`;
  }
  return null;
}

/** Data prevista nao pode ser vazia nem visivelmente invalida. */
export function validarDataPrevista(dataISO: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dataISO)) return "Informe uma data prevista válida.";
  return null;
}

/* ------------------------------------------------------------------ */
/* Mensagens de lembrete                                               */
/* ------------------------------------------------------------------ */

const reais = (cents: number) => (cents / 100).toFixed(2).replace(".", ",");

/** "Opa! Hoje e dia de cobrar o adiantamento do cliente Joao, no valor de R$ 200,00." */
export function mensagemLembreteHoje(clienteNome: string, valorCents: number): { title: string; body: string } {
  return {
    title: "Adiantamento para cobrar hoje",
    body: `Opa! Hoje é dia de cobrar o adiantamento do cliente ${clienteNome}, no valor de R$ ${reais(valorCents)}.`,
  };
}

/** "O adiantamento de João, no valor de R$ 200,00, está previsto para daqui a 3 dias." */
export function mensagemLembreteAntecipado(
  clienteNome: string,
  valorCents: number,
  dias: number,
): { title: string; body: string } {
  const quando = dias === 1 ? "amanhã" : `daqui a ${dias} dias`;
  return {
    title: "Adiantamento agendado se aproxima",
    body: `O adiantamento de ${clienteNome}, no valor de R$ ${reais(valorCents)}, está previsto para ${quando}.`,
  };
}
