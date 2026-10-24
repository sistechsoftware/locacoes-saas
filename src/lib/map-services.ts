import { one, run } from "./db";
import { geocodeAddress, roadLegs, roadRouteOptions, RouteError, type AlternativaRota, type MapServices, type Place } from "./routes";
import { nominatimSearch, type SugestaoEndereco } from "./address-search";

/** App-wide persistent gate: >=1.1s between public-service requests, across isolates. */
async function gate(service: string) {
  await run("INSERT OR IGNORE INTO api_rate_limits(bucket,count,expires_at) VALUES (?,0,?)", [service, Math.floor(Date.now()/1000)+60]);
  for (let attempt = 0; attempt < 15; attempt++) {
    const now = Date.now();
    const result = await run("UPDATE api_rate_limits SET count=?,expires_at=? WHERE bucket=? AND count<=?", [now+1100, Math.floor(now/1000)+60, service, now]);
    if (result.meta.changes) return;
    await new Promise(resolve => setTimeout(resolve, 1100));
  }
  throw new RouteError("Mapas ocupados. Aguarde alguns segundos e tente novamente.", 429);
}
export function openMapServices(nominatim: string, osrm: string): MapServices {
  return {
    async geocode(address) {
      const key = `geocode:${nominatim}:${address.toLowerCase()}`;
      const cached = await one<{ payload: string }>("SELECT payload FROM route_cache WHERE cache_key=? AND expires_at>?", [key, Math.floor(Date.now()/1000)]);
      if (cached) return JSON.parse(cached.payload) as Place;
      await gate("nominatim:gate");
      const place = await geocodeAddress(address, nominatim);
      await run("INSERT INTO route_cache(cache_key,payload,expires_at) VALUES (?,?,?) ON CONFLICT(cache_key) DO UPDATE SET payload=excluded.payload,expires_at=excluded.expires_at", [key, JSON.stringify(place), Math.floor(Date.now()/1000)+2592000]);
      return place;
    },
    async route(points) { await gate("osrm:gate"); return roadLegs(points, osrm); },
    /** Alternativas com geometria, cacheadas no D1 (permitido para OSM). */
    async routeOptions(points) {
      const key = `routeoptions:${osrm}:${points.map(p => `${p.lat.toFixed(6)},${p.lon.toFixed(6)}`).join(";")}`;
      const cached = await one<{ payload: string }>("SELECT payload FROM route_cache WHERE cache_key=? AND expires_at>?", [key, Math.floor(Date.now()/1000)]);
      if (cached) return JSON.parse(cached.payload) as AlternativaRota[];
      await gate("osrm:gate");
      const options = await roadRouteOptions(points, osrm);
      await run("INSERT INTO route_cache(cache_key,payload,expires_at) VALUES (?,?,?) ON CONFLICT(cache_key) DO UPDATE SET payload=excluded.payload,expires_at=excluded.expires_at", [key, JSON.stringify(options), Math.floor(Date.now()/1000)+86400]);
      return options;
    },
  };
}

/**
 * Sugestões de endereço pelo Nominatim, cacheadas no D1 por 24h. O cache é
 * recomendado pela política do OSMF e evita repetir consulta ao serviço público.
 * (No caminho Google as sugestões NÃO são cacheadas — os termos do Google
 * restringem armazenamento de conteúdo; só coordenadas podem ficar 30 dias.)
 */
export async function searchSuggestionsCached(nominatim: string, query: string): Promise<SugestaoEndereco[]> {
  const chave = `suggest:${nominatim}:${query.trim().toLowerCase()}`;
  const agora = Math.floor(Date.now()/1000);
  const cached = await one<{ payload: string }>("SELECT payload FROM route_cache WHERE cache_key=? AND expires_at>?", [chave, agora]);
  if (cached) return JSON.parse(cached.payload) as SugestaoEndereco[];
  await gate("nominatim:gate");
  const sugestoes = await nominatimSearch(query, nominatim);
  await run("INSERT INTO route_cache(cache_key,payload,expires_at) VALUES (?,?,?) ON CONFLICT(cache_key) DO UPDATE SET payload=excluded.payload,expires_at=excluded.expires_at", [chave, JSON.stringify(sugestoes), agora + 86400]);
  return sugestoes;
}
