import { getCloudflareContext } from "@opennextjs/cloudflare";
import { requireModule } from "@/lib/auth";
import { getSettings } from "@/lib/settings";
import { freightConfig } from "@/lib/freight-config";
import { providerEndereco } from "@/lib/address-search";
import { PageHeader } from "@/components/ui";
import Calculator from "./Calculator";
import { salvarPrecoCombustivel } from "../actions";

export const dynamic = "force-dynamic";

export default async function CalculadoraFretePage() {
  await requireModule("fretes");
  const s = await getSettings();

  /*
   * Chave pública do Google Maps (restrita por origem no Console) habilita o
   * mapa da rota; sem ela a calculadora segue funcionando (rota e distância
   * reais), apenas sem o desenho no mapa. Em dev sem bindings do Cloudflare o
   * try/catch mantém a tela de pé.
   */
  let mapKey: string | null = null;
  let provider: "google" | "osm" = "osm";
  try {
    const env = getCloudflareContext().env;
    mapKey = env.GOOGLE_MAPS_CLIENT_KEY?.trim() || null;
    provider = providerEndereco(env.GOOGLE_MAPS_API_KEY);
  } catch { /* rodando fora do contexto Cloudflare (dev sem binding) */ }

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <PageHeader title="Calcular Frete" subtitle="Quanto cobrar por uma viagem" />
      <Calculator
        configs={{ comum: freightConfig(s, "comum"), locacao: freightConfig(s, "locacao") }}
        salvarPreco={salvarPrecoCombustivel}
        mapKey={mapKey}
        provider={provider}
      />
    </div>
  );
}
