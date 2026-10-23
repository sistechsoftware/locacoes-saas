import { getCloudflareContext } from "@opennextjs/cloudflare";
import { apiUser, rateLimit, smallJson } from "@/lib/api-security";
import { getSettings } from "@/lib/settings";
import { freightConfig } from "@/lib/freight-config";
import { googleRouteOptions, RouteError, type AlternativaRota, type Place } from "@/lib/routes";
import { openMapServices } from "@/lib/map-services";
import { providerEndereco, resolverDestino, type DestinoResolvido } from "@/lib/address-search";
import { one, run } from "@/lib/db";

/**
 * Opções de rota para a calculadora de frete: base → destino (só a IDA).
 *
 * A origem é SEMPRE o endereço-base da empresa autenticada, lido das
 * configurações da própria empresa (company_settings via getSettings da
 * sessão) — nenhuma empresa enxerga a base de outra. O destino é o texto
 * escolhido pelo usuário; a distância de cada alternativa alimenta o campo
 * "Distância de ida (km)" e a fórmula comercial existente multiplica pelas
 * viagens do tipo. Nada de linha reta: tudo aqui é trajeto rodoviário.
 *
 * Sem GOOGLE_MAPS_API_KEY o provedor é o OSM (Nominatim + OSRM), com cache
 * no D1. No caminho Google não gravamos cache de rotas (termos de uso
 * restringem armazenamento de conteúdo; coordenadas resolvidas podem ficar
 * 30 dias — e é só o que persistimos).
 */
export async function POST(request: Request) {
  const user = await apiUser(request, true);
  if (user instanceof Response) return user;
  if (!user) return Response.json({ error: "Sessão expirada ou origem inválida." }, { status: 401 });
  try {
    if (!await rateLimit(`maps:${user.id}`, 30)) throw new RouteError("Muitas consultas. Aguarde um minuto.", 429);
    const input = await smallJson(request);
    const env = getCloudflareContext().env;
    const tipo = input.tipo === "locacao" ? "locacao" : "comum";
    const provider = providerEndereco(env.GOOGLE_MAPS_API_KEY);
    const config = freightConfig(await getSettings(), tipo);
    const destino = String(input.destination ?? "").trim();
    if (!config.baseAddress.trim()) throw new RouteError("Cadastre o endereço-base da empresa em Configurações › Frete antes de calcular.");
    if (destino.length < 3) throw new RouteError("Informe o endereço de destino.");
    if (destino.length > 400) throw new RouteError("Endereço longo demais. Encurte a consulta.");

    const cacheKey = await chaveCache(provider, tipo, config.baseAddress, destino, env.GOOGLE_MAPS_API_KEY, env.NOMINATIM_URL);
    const now = Math.floor(Date.now() / 1000);
    // Cache só no caminho OSM; no Google armazenar rotas viola os termos.
    if (provider === "osm") {
      const cached = await one<{ payload: string }>("SELECT payload FROM route_cache WHERE cache_key=? AND expires_at>?", [cacheKey, now]);
      if (cached) return Response.json(JSON.parse(cached.payload), { headers: { "Cache-Control": "no-store" } });
    }
    // Lease curto no D1 agrupa cálculos idênticos concorrentes entre isolates.
    if (!await rateLimit(`route:${cacheKey}`, 1, 15)) throw new RouteError("Esta rota já está sendo calculada. Tente novamente em alguns segundos.", 429);
    if (!await rateLimit("maps:calculator:daily", 500, 86400)) throw new RouteError("Limite diário de cálculos atingido. Use o valor manual ou tente amanhã.", 429);

    const services = openMapServices(env.NOMINATIM_URL, env.OSRM_URL);
    const destinoResolvido = await resolverDestino(destino, provider, { googleKey: env.GOOGLE_MAPS_API_KEY, nominatimUrl: env.NOMINATIM_URL });
    const origem = await geocodificarBase(config.baseAddress, provider, env, services);

    let alternativas: AlternativaRota[];
    if (provider === "google") {
      alternativas = await googleRouteOptions(origem, { label: destinoResolvido.label, lat: destinoResolvido.lat, lon: destinoResolvido.lon }, env.GOOGLE_MAPS_API_KEY!);
    } else {
      if (!services.routeOptions) throw new RouteError("Roteamento indisponível.", 503);
      alternativas = await services.routeOptions([origem, { label: destinoResolvido.label, lat: destinoResolvido.lat, lon: destinoResolvido.lon }]);
    }

    const payload = montarResposta(provider, tipo, origem, destinoResolvido, alternativas);
    if (provider === "osm") {
      await run("INSERT INTO route_cache(cache_key,payload,expires_at) VALUES (?,?,?) ON CONFLICT(cache_key) DO UPDATE SET payload=excluded.payload,expires_at=excluded.expires_at", [cacheKey, JSON.stringify(payload), now + 86400]);
    }
    return Response.json(payload, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json(
      { error: error instanceof RouteError ? error.message : "Não foi possível consultar a rota. Confira os dados e tente novamente." },
      { status: error instanceof RouteError ? error.status : 400 },
    );
  }
}

export type RespostaOpcoes = {
  provider: "google" | "osm";
  tipo: "comum" | "locacao";
  origem: { label: string; lat: number; lon: number };
  destino: DestinoResolvido;
  opcoes: AlternativaRota[];
};

export function montarResposta(
  provider: "google" | "osm",
  tipo: "comum" | "locacao",
  origem: Place,
  destino: DestinoResolvido,
  alternativas: AlternativaRota[],
): RespostaOpcoes {
  return {
    provider,
    tipo,
    origem: { label: origem.label, lat: origem.lat, lon: origem.lon },
    destino,
    opcoes: alternativas.map((a, i) => ({ ...a, index: i })),
  };
}

/** Geocodifica a base da empresa uma vez por cálculo (cache próprio do serviço OSM). */
async function geocodificarBase(base: string, provider: "google" | "osm", env: CloudflareEnv, services: ReturnType<typeof openMapServices>): Promise<Place> {
  if (provider === "osm") return services.geocode(base);
  const resolvido = await resolverDestino(base, "google", { googleKey: env.GOOGLE_MAPS_API_KEY });
  return { label: resolvido.label, lat: resolvido.lat, lon: resolvido.lon };
}

async function chaveCache(provider: string, tipo: string, base: string, destino: string, googleKey: string | null | undefined, nominatim: string): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify([provider, tipo, base.trim().toLowerCase(), destino.toLowerCase(), googleKey ? "g" : nominatim]));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map(x => x.toString(16).padStart(2, "0")).join("");
}
