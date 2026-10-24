import { getCloudflareContext } from "@opennextjs/cloudflare";
import { apiUser, rateLimit, smallJson } from "@/lib/api-security";
import { RouteError } from "@/lib/routes";
import { googleAutocomplete, providerEndereco, type SugestaoEndereco } from "@/lib/address-search";
import { searchSuggestionsCached } from "@/lib/map-services";

/**
 * Sugestões de endereço para o autocomplete da calculadora de frete.
 *
 * Provedor vem do ambiente: com GOOGLE_MAPS_API_KEY usa Places API (New)
 * Autocomplete (restrito ao Brasil); sem chave, cai no Nominatim público já
 * usado pelo SaaS. Cada sugestão traz os componentes disponíveis (logradouro,
 * número, bairro, CEP, cidade, UF) para o usuário CONFIRMAR o destino certo —
 * nada de lista de rótulos opacos.
 *
 * Autocomplete só consultamos depois de o usuário digitar o suficiente; no
 * caminho OSM as respostas ficam cacheadas 24h no D1 (política do OSMF
 * recomenda cache); no caminho Google não armazenamos sugestões (termos).
 */
export async function POST(request: Request) {
  const user = await apiUser(request, true);
  if (user instanceof Response) return user;
  if (!user) return Response.json({ error: "Sessão expirada ou origem inválida." }, { status: 401 });
  try {
    if (!await rateLimit(`geocode:${user.id}`, 30)) throw new RouteError("Muitas consultas. Aguarde um momento.", 429);
    const input = await smallJson(request);
    const query = String(input.query ?? "").trim();
    if (query.length < 4) return Response.json({ provider: null, suggestions: [] });

    const env = getCloudflareContext().env;
    const provider = providerEndereco(env.GOOGLE_MAPS_API_KEY);
    let suggestions: SugestaoEndereco[];
    if (provider === "google") {
      suggestions = await googleAutocomplete(query, env.GOOGLE_MAPS_API_KEY!);
    } else {
      suggestions = await searchSuggestionsCached(env.NOMINATIM_URL, query);
    }
    return Response.json({ provider, suggestions: suggestions.slice(0, 6) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json(
      { error: error instanceof RouteError ? error.message : "Não foi possível buscar endereços agora. Você pode digitar o endereço completo manualmente." },
      { status: error instanceof RouteError ? error.status : 400 },
    );
  }
}
