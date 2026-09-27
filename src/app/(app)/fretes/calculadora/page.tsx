import { requireUser } from "@/lib/auth";
import { getSettings } from "@/lib/settings";
import { freightConfig } from "@/lib/freight-config";
import { PageHeader } from "@/components/ui";
import Calculator, { type ConfigFrete } from "./Calculator";
import { salvarPrecoCombustivel } from "../actions";

export const dynamic = "force-dynamic";

export default async function CalculadoraFretePage() {
  await requireUser();
  const s = await getSettings();

  const config: ConfigFrete = {
    fuelType: s.freight_fuel_type || "Combustível",
    fuelPriceCents: Number(s.freight_fuel_price_cents) || 0,
    consumption: Number(s.freight_consumption) || 0,
    costPerKmCents: Number(s.freight_cost_per_km_cents) || 0,
    marginPercent: Number(s.freight_margin_percent) || 0,
    minimumCents: Number(s.freight_minimum_cents) || 0,
    roundingCents: Number(s.freight_rounding_cents) || 0,
    laborCents: Number(s.freight_labor_cents) || 0,
  };

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <PageHeader title="Calcular Frete" subtitle="Quanto cobrar por uma viagem" />
      <Calculator configs={{ comum: freightConfig(s,"comum"), locacao: freightConfig(s,"locacao") }} salvarPreco={salvarPrecoCombustivel} />
    </div>
  );
}
