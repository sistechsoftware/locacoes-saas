import type { TipoFrete } from "./freight";
import { priceRoadDistance, type ConfigFrete } from "./freight-config";
import { decodePolyline, encodePolyline } from "./polyline";

export class RouteError extends Error {
  constructor(message: string, public status = 422) { super(message); }
}
export type RoadRoute = { labels: string[]; legsKm: number[]; totalKm: number; suggestedCents: number };
export type Place = { label: string; lat: number; lon: number };
export type MapServices = {
  geocode: (address: string) => Promise<Place>;
  route: (points: Place[]) => Promise<number[]>;
  /** Alternativas com geometria (opcional: só os caminhos que precisam delas). */
  routeOptions?: (points: Place[]) => Promise<AlternativaRota[]>;
};
export function routeAddresses(tipo: TipoFrete, base: string, origin: string, destination: string) {
  if (!base.trim()) throw new RouteError("Cadastre o endereço-base deste tipo de frete nas configurações.");
  const values = tipo === "comum" ? [base, origin, destination, base] : [base, destination, base];
  if (values.some(a => a.trim().length < 10 || a.length > 400)) throw new RouteError("Informe endereços completos: rua, número, cidade e estado.");
  return values.map(a => a.trim());
}
export async function mapJson(url: URL, request: typeof fetch = fetch, maxBytes = 256000) {
  let response: Response;
  try {
    response = await request(url, { signal: AbortSignal.timeout(10000), cache: "no-store", headers: {
      "User-Agent": "LimasLocacoes/1.0 (+https://limas-locacoes.limas-locacoes.workers.dev)", "Accept": "application/json",
    } });
  } catch { throw new RouteError("Não foi possível conectar ao serviço de mapas. Tente novamente.", 503); }
  if (response.status === 429) throw new RouteError("Limite do serviço de mapas atingido. Aguarde e tente novamente.", 429);
  if (!response.ok) throw new RouteError("Serviço público de mapas indisponível. Use o valor manual ou tente mais tarde.", 503);
  const reader = response.body?.getReader();
  if (!reader) throw new RouteError("Resposta vazia dos mapas.", 503);
  let size = 0, text = "";
  const decoder = new TextDecoder();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maxBytes) { await reader.cancel(); throw new RouteError("Resposta inesperada dos mapas.", 503); }
    text += decoder.decode(value, { stream: true });
  }
  try { return JSON.parse(text + decoder.decode()); }
  catch { throw new RouteError("Resposta inválida dos mapas.", 503); }
}
export async function geocodeAddress(address: string, endpoint: string, request: typeof fetch = fetch): Promise<Place> {
  const url = new URL("search", endpoint.endsWith("/") ? endpoint : endpoint + "/");
  url.search = new URLSearchParams({ q: address, format: "jsonv2", countrycodes: "br", limit: "1", addressdetails: "1", "accept-language": "pt-BR" }).toString();
  const data = await mapJson(url, request);
  const p = Array.isArray(data) ? data[0] : null;
  if (!p || !Number.isFinite(Number(p.lat)) || !Number.isFinite(Number(p.lon))) throw new RouteError(`Endereço não encontrado: ${address}`);
  if (!p.address?.road && !p.address?.pedestrian && !p.address?.house_number) throw new RouteError(`Endereço incompleto: ${address}. Inclua rua e número.`);
  return { label: p.display_name, lat: Number(p.lat), lon: Number(p.lon) };
}
export async function roadLegs(points: Place[], endpoint: string, request: typeof fetch = fetch): Promise<number[]> {
  const url = new URL(`${endpoint.replace(/\/$/, "")}/route/v1/driving/${points.map(p => `${p.lon},${p.lat}`).join(";")}`);
  url.search = "overview=false&steps=false&alternatives=false";
  const data = await mapJson(url, request);
  const legs = data.routes?.[0]?.legs;
  if (data.code !== "Ok" || !Array.isArray(legs) || legs.length !== points.length - 1 || legs.some(l => !Number.isFinite(l.distance) || l.distance < 0)) throw new RouteError("Nenhuma rota rodoviária encontrada entre estes endereços.");
  return legs.map(l => l.distance / 1000);
}
/**
 * Uma alternativa de trajeto entre a MESMA origem e o MESMO destino: distância
 * rodoviária, duração estimada e a geometria real (polyline codificada,
 * precisão 5) para desenhar o traçado no mapa. Nunca é "endereço alternativo".
 */
export type AlternativaRota = {
  index: number;
  totalKm: number;
  durationMin: number | null;
  /** Polyline codificada do trajeto (precision 5); vazia quando o provedor não devolve geometria. */
  geometry: string;
};

/**
 * Alternativas rodoviárias do OSRM para o mesmo percurso, com geometria.
 * `alternatives=3` devolve até 4 trajetos (o principal + 3), mas o serviço
 * pode retornar menos — quem chama nunca deve prometer quantidade.
 */
export async function roadRouteOptions(points: Place[], endpoint: string, request: typeof fetch = fetch): Promise<AlternativaRota[]> {
  const url = new URL(`${endpoint.replace(/\/$/, "")}/route/v1/driving/${points.map(p => `${p.lon},${p.lat}`).join(";")}`);
  url.search = "overview=full&steps=false&alternatives=3&geometries=geojson";
  // Rotas interestaduais vêm com centenas de KB de geometria: o teto padrão de
  // 256KB não basta, então pedimos mais — e simplificamos antes de cache/enviar.
  const data = await mapJson(url, request, 4_000_000);
  if (data.code !== "Ok" || !Array.isArray(data.routes)) throw new RouteError("Nenhuma rota rodoviária encontrada entre estes endereços.");
  const opcoes: AlternativaRota[] = [];
  for (const route of data.routes) {
    const legs = route?.legs;
    if (!Array.isArray(legs) || legs.length !== points.length - 1) continue;
    if (legs.some((l: { distance?: unknown }) => !Number.isFinite(l?.distance as number) || (l.distance as number) < 0)) continue;
    const totalKm = legs.reduce((sum: number, l: { distance: number }) => sum + l.distance, 0) / 1000;
    if (!(totalKm > 0)) continue;
    const duration = Number(route.duration);
    const geometry = geometryDoOsrm(route.geometry);
    opcoes.push({
      index: opcoes.length,
      totalKm,
      durationMin: Number.isFinite(duration) && duration >= 0 ? Math.round(duration / 60) : null,
      geometry,
    });
  }
  if (!opcoes.length) throw new RouteError("Nenhuma rota rodoviária encontrada entre estes endereços.");
  return opcoes;
}

/** Geometria do OSRM pode chegar como polyline codificada ou GeoJSON (conforme `geometries`). */
function geometryDoOsrm(geometry: unknown): string {
  if (typeof geometry === "string") return simplifyPolyline(geometry);
  const g = geometry as { type?: string; coordinates?: [number, number][] } | undefined;
  if (g?.type === "LineString" && Array.isArray(g.coordinates) && g.coordinates.length > 1) {
    return simplifyPolyline(encodePolyline(g.coordinates.map(([lon, lat]) => [lat, lon] as [number, number])));
  }
  return "";
}

/**
 * Limita a polyline a no máximo `maxPontos` pontos, preservando início e fim.
 * O traçado continua sendo o trajeto real (amostrado), só mais leve para
 * cachear no D1 e desenhar no navegador — uma rota de 600km não precisa de
 * 7.000 pontos para aparecer igual no mapa.
 */
export function simplifyPolyline(encoded: string, maxPontos = 800): string {
  if (!encoded) return "";
  const pontos = decodePolyline(encoded);
  if (pontos.length <= maxPontos) return encoded;
  const passo = Math.ceil(pontos.length / maxPontos);
  const amostra: [number, number][] = [];
  for (let i = 0; i < pontos.length - 1; i += passo) amostra.push(pontos[i]);
  amostra.push(pontos[pontos.length - 1]);
  return encodePolyline(amostra);
}

/**
 * Alternativas rodoviárias pela Google Routes API (`computeRoutes`), com
 * `computeAlternativeRoutes: true` — devolve o trajeto principal e até três
 * alternativas (menos quando não há caminhos suficientemente diferentes).
 * A polyline vem codificada no campo `polyline.encodedPolyline`.
 */
export async function googleRouteOptions(origin: Place, destination: Place, apiKey: string, request: typeof fetch = fetch): Promise<AlternativaRota[]> {
  const response = await request("https://routes.googleapis.com/directions/v2:computeRoutes", {
    method: "POST",
    signal: AbortSignal.timeout(15000),
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": "routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline,routes.viewport",
    },
    body: JSON.stringify({
      origin: { location: { latLng: { latitude: origin.lat, longitude: origin.lon } } },
      destination: { location: { latLng: { latitude: destination.lat, longitude: destination.lon } } },
      travelMode: "DRIVE",
      routingPreference: "TRAFFIC_UNAWARE",
      computeAlternativeRoutes: true,
    }),
  });
  if (response.status === 429) throw new RouteError("Limite do serviço de mapas atingido. Aguarde e tente novamente.", 429);
  if (!response.ok) throw new RouteError("Serviço de rotas indisponível. Tente novamente em instantes.", 503);
  const data = await response.json() as {
    routes?: Array<{ distanceMeters?: number; duration?: string; polyline?: { encodedPolyline?: string } }>;
    errorMessage?: string;
  };
  const opcoes: AlternativaRota[] = [];
  for (const route of data.routes ?? []) {
    const totalMeters = Number(route.distanceMeters);
    if (!Number.isFinite(totalMeters) || totalMeters <= 0) continue;
    // Duração vem como "3600s" (duração do protobuf).
    const segundos = typeof route.duration === "string" ? Number(route.duration.replace(/s$/, "")) : Number(route.duration);
    opcoes.push({
      index: opcoes.length,
      totalKm: totalMeters / 1000,
      durationMin: Number.isFinite(segundos) && segundos >= 0 ? Math.round(segundos / 60) : null,
      geometry: simplifyPolyline(typeof route.polyline?.encodedPolyline === "string" ? route.polyline.encodedPolyline : ""),
    });
  }
  if (!opcoes.length) throw new RouteError("Nenhuma rota rodoviária encontrada entre estes endereços.");
  return opcoes;
}

export async function calculateRoadRoute(tipo: TipoFrete, c: ConfigFrete, origin: string, destination: string, services: MapServices): Promise<RoadRoute> {
  const addresses = routeAddresses(tipo, c.baseAddress, origin, destination);
  const places = new Map<string, Place>();
  for (const address of new Set(addresses)) places.set(address, await services.geocode(address));
  const points = addresses.map(a => places.get(a)!);
  const legsKm = await services.route(points);
  if (legsKm.length !== points.length - 1 || legsKm.some(k => !Number.isFinite(k) || k < 0)) throw new RouteError("Rota rodoviária inválida.");
  const totalKm = legsKm.reduce((sum, km) => sum + km, 0);
  if (!totalKm) throw new RouteError("Os pontos informados não formam um percurso. Confira os endereços.");
  return { labels: points.map(p => p.label), legsKm, totalKm, suggestedCents: priceRoadDistance(totalKm, tipo, c).valorSugeridoCents };
}
