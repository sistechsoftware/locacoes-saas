/**
 * Calculo do preco de um frete, em funcoes puras.
 *
 * Nao acessa banco: recebe os parametros e devolve o detalhamento. Isso mantem
 * a regra num lugar so e permite testar as formulas sem infraestrutura.
 *
 * Todo dinheiro circula em centavos (inteiro), para nao acumular erro de ponto
 * flutuante. Distancia e consumo sao decimais de verdade.
 */

export type TipoFrete = "comum" | "locacao";

/**
 * Numero de deslocamentos por tipo de servico.
 *
 * Um frete comum e ida e volta. Uma locacao sao quatro trechos: leva, volta,
 * retorna no dia seguinte para buscar, e volta de novo. Cobrar locacao como se
 * fossem duas viagens subestima o custo real pela metade.
 */
export const VIAGENS: Record<TipoFrete, number> = {
  comum: 2,
  locacao: 4,
};

export type ParametrosFrete = {
  /** Distancia só de ida, em km. */
  distanciaIdaKm: number;
  tipo: TipoFrete;
  /** Consumo medio do veiculo, em km/L. */
  consumoKmPorLitro: number;
  precoLitroCents: number;
  custoPorKmCents: number;
  pedagioCents: number;
  maoDeObraCents: number;
  /** Margem de lucro sobre o preco de venda, em porcentagem. */
  margemPercent: number;
  valorMinimoCents: number;
  /** Multiplo para o valor sugerido (0 desliga o arredondamento). */
  arredondamentoCents: number;
};

export type ResultadoFrete = {
  tipo: TipoFrete;
  distanciaIdaKm: number;
  viagens: number;
  distanciaTotalKm: number;
  consumoKmPorLitro: number;
  litros: number;
  custoCombustivelCents: number;
  custoOperacionalCents: number;
  pedagioCents: number;
  maoDeObraCents: number;
  custoTotalCents: number;
  margemPercent: number;
  precoCalculadoCents: number;
  /** Verdadeiro quando o minimo configurado prevaleceu sobre o calculo. */
  aplicouMinimo: boolean;
  valorMinimoCents: number;
  precoFinalCents: number;
  valorSugeridoCents: number;
  /** Quanto sobra depois de pagar o custo, no valor sugerido. */
  lucroEstimadoCents: number;
};

/** Margem de 100% deixaria a divisao sem solucao; o teto protege a conta. */
const MARGEM_MAXIMA = 95;

/** Arredonda para cima ate o proximo multiplo, que e como se cobra na pratica. */
export function arredondarComercial(valorCents: number, multiploCents: number): number {
  if (!multiploCents || multiploCents <= 0) return valorCents;
  return Math.ceil(valorCents / multiploCents) * multiploCents;
}

export function calcularFrete(p: ParametrosFrete): ResultadoFrete {
  const distanciaIdaKm = Math.max(0, Number(p.distanciaIdaKm) || 0);
  const tipo: TipoFrete = p.tipo === "locacao" ? "locacao" : "comum";
  const viagens = VIAGENS[tipo];
  const distanciaTotalKm = distanciaIdaKm * viagens;

  const consumo = Number(p.consumoKmPorLitro) || 0;
  // sem consumo valido nao da para estimar combustivel; o resto do custo segue
  const litros = consumo > 0 ? distanciaTotalKm / consumo : 0;

  const custoCombustivelCents = Math.round(litros * Math.max(0, p.precoLitroCents || 0));
  const custoOperacionalCents = Math.round(distanciaTotalKm * Math.max(0, p.custoPorKmCents || 0));
  const pedagioCents = Math.max(0, Math.round(p.pedagioCents || 0));
  const maoDeObraCents = Math.max(0, Math.round(p.maoDeObraCents || 0));

  const custoTotalCents = custoCombustivelCents + custoOperacionalCents + pedagioCents + maoDeObraCents;

  /*
   * Margem sobre o PRECO DE VENDA, nao sobre o custo.
   *
   * Com 30% de margem, o lucro precisa ser 30% do que o cliente paga, entao o
   * custo representa os 70% restantes: preco = custo / 0,70. Somar 30% ao custo
   * daria um preco menor e uma margem real de apenas 23%.
   */
  const margemPercent = Math.min(MARGEM_MAXIMA, Math.max(0, Number(p.margemPercent) || 0));
  const precoCalculadoCents = Math.round(custoTotalCents / (1 - margemPercent / 100));

  const valorMinimoCents = Math.max(0, Math.round(p.valorMinimoCents || 0));
  const aplicouMinimo = precoCalculadoCents < valorMinimoCents;
  const precoFinalCents = aplicouMinimo ? valorMinimoCents : precoCalculadoCents;

  const valorSugeridoCents = arredondarComercial(precoFinalCents, Math.max(0, p.arredondamentoCents || 0));

  return {
    tipo,
    distanciaIdaKm,
    viagens,
    distanciaTotalKm,
    consumoKmPorLitro: consumo,
    litros,
    custoCombustivelCents,
    custoOperacionalCents,
    pedagioCents,
    maoDeObraCents,
    custoTotalCents,
    margemPercent,
    precoCalculadoCents,
    aplicouMinimo,
    valorMinimoCents,
    precoFinalCents,
    valorSugeridoCents,
    lucroEstimadoCents: valorSugeridoCents - custoTotalCents,
  };
}
