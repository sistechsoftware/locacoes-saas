import { calcularFrete, VIAGENS, type TipoFrete } from "./freight";

export type ConfigFrete = {
  baseAddress: string; fuelType: string; fuelPriceCents: number; consumption: number;
  costPerKmCents: number; marginPercent: number; minimumCents: number;
  roundingCents: number; laborCents: number;
};
export function freightConfig(s: Record<string, string>, tipo: TipoFrete): ConfigFrete {
  /*
   * Especifica do tipo quando preenchida; vazia ou ausente cai no generico
   * (freight_*), que e o padrao historico salvo pelas empresas. Tratar ""
   * como ausente e o que preserva esse fallback depois que as chaves por tipo
   * passaram a ser gravadas em company_settings.
   */
  const especifica = (key: string) => {
    const v = s[`freight_${tipo}_${key}`];
    return typeof v === "string" && v !== "" ? v : undefined;
  };
  const read = (key: string) => especifica(key) ?? s[`freight_${key}`] ?? "";
  return {
    baseAddress: especifica("base_address") ?? "",
    fuelType: read("fuel_type"), fuelPriceCents: Number(read("fuel_price_cents")),
    consumption: Number(read("consumption")), costPerKmCents: Number(read("cost_per_km_cents")),
    marginPercent: Number(read("margin_percent")), minimumCents: Number(read("minimum_cents")),
    roundingCents: Number(read("rounding_cents")), laborCents: Number(read("labor_cents")),
  };
}

/** Only the distance source changes. The existing cents/margin/minimum formula is reused. */
export function priceRoadDistance(totalKm: number, tipo: TipoFrete, c: ConfigFrete) {
  if (!Number.isFinite(totalKm) || totalKm <= 0) throw new Error("Distancia rodoviaria invalida.");
  return calcularFrete({
    tipo, distanciaIdaKm: totalKm / VIAGENS[tipo], consumoKmPorLitro: c.consumption,
    precoLitroCents: c.fuelPriceCents, custoPorKmCents: c.costPerKmCents,
    margemPercent: c.marginPercent, valorMinimoCents: c.minimumCents,
    arredondamentoCents: c.roundingCents, maoDeObraCents: c.laborCents, pedagioCents: 0,
  });
}
