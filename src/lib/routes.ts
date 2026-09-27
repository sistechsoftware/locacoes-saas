import type { TipoFrete } from "./freight";
import { priceRoadDistance, type ConfigFrete } from "./freight-config";

export class RouteError extends Error {
  constructor(message: string, public status = 422) { super(message); }
}
export type RoadRoute = { labels: string[]; legsKm: number[]; totalKm: number; suggestedCents: number };
export type Place = { label: string; lat: number; lon: number };
export type MapServices = { geocode: (address: string) => Promise<Place>; route: (points: Place[]) => Promise<number[]> };
export function routeAddresses(tipo: TipoFrete, base: string, origin: string, destination: string) {
  if (!base.trim()) throw new RouteError("Cadastre o endereço-base deste tipo de frete nas configurações.");
  const values = tipo === "comum" ? [base, origin, destination, base] : [base, destination, base];
  if (values.some(a => a.trim().length < 10 || a.length > 400)) throw new RouteError("Informe endereços completos: rua, número, cidade e estado.");
  return values.map(a => a.trim());
}
export async function mapJson(url: URL, request: typeof fetch = fetch) {
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
    if (size > 256000) { await reader.cancel(); throw new RouteError("Resposta inesperada dos mapas.", 503); }
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
