import { calcularFrete, VIAGENS, type TipoFrete } from "./freight";

export type ConfigFrete = {
  baseAddress: string; fuelType: string; fuelPriceCents: number; consumption: number;
  costPerKmCents: number; marginPercent: number; minimumCents: number;
  roundingCents: number; laborCents: number;
};
export function freightConfig(s: Record<string, string>, tipo: TipoFrete): ConfigFrete {
  const read = (key: string) => s[`freight_${tipo}_${key}`] ?? s[`freight_${key}`] ?? "";
  return {
    baseAddress: s[`freight_${tipo}_base_address`] ?? "",
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
