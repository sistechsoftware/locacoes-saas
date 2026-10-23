import { requireModule } from "@/lib/auth";
import { getSettings } from "@/lib/settings";
import { freightConfig } from "@/lib/freight-config";
import { PageHeader } from "@/components/ui";
import Calculator from "./Calculator";
import { salvarPrecoCombustivel } from "../actions";

export const dynamic = "force-dynamic";

export default async function CalculadoraFretePage() {
  await requireModule("fretes");
  const s = await getSettings();

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <PageHeader title="Calcular Frete" subtitle="Quanto cobrar por uma viagem" />
      <Calculator configs={{ comum: freightConfig(s,"comum"), locacao: freightConfig(s,"locacao") }} salvarPreco={salvarPrecoCombustivel} />
    </div>
  );
}
