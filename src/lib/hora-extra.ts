/**
 * HORA EXTRA NA EXTENSÃO DE RETIRADA.
 *
 * Regra de negócio: quando o operador AVANÇA o pickup_at de uma reserva ou
 * orçamento já gravado, o tempo novo é cobrado por hora cheia enquanto a
 * extensão for menor que o limite configurado; igual ou maior que o limite,
 * NADA é cobrado automaticamente (a UI avisa e o operador negocia — pode ser
 * uma diária adicional, pode ser cortesia).
 *
 * Proteção contra dupla cobrança: se a extensão já cruzou a meia-noite e
 * acrescentou um dia de calendário, as linhas 'diária' somam +1 diária no
 * recálculo do período — nesse caso a hora extra NÃO é cobrada.
 *
 * Cálculo puro, compartilhado entre servidor (actions) e cliente (preview no
 * formulário): o servidor é quem grava, o navegador só mostra o que vai
 * acontecer antes do salvar. Sem dependência de server-only para poder ser
 * importado nos formulários.
 */
import { diasCobrados, parseLocal } from "./format";

export type ExtensaoInput = {
  pickupAnterior: string | null | undefined;
  pickupNovo: string | null | undefined;
  deliveryAnterior?: string | null | undefined;
  deliveryNovo?: string | null | undefined;
  /** Settings da empresa: 0 (ou ausente) desliga o recurso. */
  precoHoraCents: number;
  /** A partir de quantas horas a extensão vira negociação (diária). */
  limiteHoras: number;
};

export type ExtensaoResultado = {
  /** Minutos estendidos (0 quando não há extensão cobrável). */
  minutos: number;
  /** Horas cheias cobradas (arredondamento por cima: 45min = 1h). */
  horasCobradas: number;
  /** Valor cobrado — entra no total como linha própria. */
  cents: number;
  /** Extensão >= limite: nada cobrado automaticamente, operador decide. */
  acimaDoLimite: boolean;
};

export const EXTENSAO_NULA: ExtensaoResultado = {
  minutos: 0,
  horasCobradas: 0,
  cents: 0,
  acimaDoLimite: false,
};

function minutosEntre(a: string, b: string): number {
  const da = parseLocal(a);
  const db = parseLocal(b);
  if (!da || !db) return 0;
  return Math.round((db.getTime() - da.getTime()) / 60000);
}

/**
 * Calcula a extensão de uma janela comparando a retirada gravada com a nova.
 *
 * - Retirada igual ou anterior → nada (encurtar não gera estorno automático).
 * - Recurso desligado (preço ou limite <= 0) → nada.
 * - Extensão que soma diária de calendário → nada (a diária já cobre).
 * - Extensão < limite → horas cheias × preço da hora extra.
 * - Extensão >= limite → acimaDoLimite, valor 0.
 */
export function calcularExtensao(input: ExtensaoInput): ExtensaoResultado {
  const { pickupAnterior, pickupNovo, precoHoraCents, limiteHoras } = input;
  if (!pickupAnterior || !pickupNovo) return { ...EXTENSAO_NULA };
  if (!(precoHoraCents > 0) || !(limiteHoras > 0)) return { ...EXTENSAO_NULA };

  const minutos = minutosEntre(pickupAnterior, pickupNovo);
  if (minutos <= 0) return { ...EXTENSAO_NULA };

  // Dupla cobrança: a janela nova já pagou uma diária a mais no recálculo do
  // período (dias de calendário) — a hora extra fica de fora.
  if (input.deliveryAnterior && input.deliveryNovo) {
    const diasAntes = diasCobrados(input.deliveryAnterior, pickupAnterior);
    const diasDepois = diasCobrados(input.deliveryNovo, pickupNovo);
    if (diasDepois > diasAntes) return { ...EXTENSAO_NULA };
  }

  if (minutos >= limiteHoras * 60) {
    return { minutos, horasCobradas: 0, cents: 0, acimaDoLimite: true };
  }

  const horasCobradas = Math.ceil(minutos / 60);
  return { minutos, horasCobradas, cents: horasCobradas * precoHoraCents, acimaDoLimite: false };
}

/** Rótulo curto para a UI: "+3h" ou "+3h30". */
export function rotuloExtensao(minutos: number | null | undefined): string {
  const m = Math.max(0, Math.round(minutos ?? 0));
  const h = Math.floor(m / 60);
  const min = m % 60;
  return `+${h}h${min ? String(min).padStart(2, "0") : ""}`;
}
