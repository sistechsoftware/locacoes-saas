/**
 * Busca e resolução de endereços brasileiros, com dois provedores
 * selecionáveis por configuração de ambiente:
 *
 *  - "google": Places API (New) Autocomplete + Geocoding API (requer
 *    GOOGLE_MAPS_API_KEY). Melhor cobertura de bairro/CEP no Brasil e termos
 *    de uso compatíveis com SaaS comercial.
 *  - "osm": Nominatim público + ViaCEP (fallback sem credenciais, mesmo
 *    serviço já usado hoje pelo SaaS). Menos preciso e com limites de uso
 *    público — documentado como transição.
 *
 * Tudo aqui é função pura com fetch injetado: os testes cobrem parsing,
 * componentes ausentes e a matriz nacional com respostas controladas, sem
 * depender de serviços externos.
 */

import { mapJson, RouteError } from "./routes";

export type AddressComponents = {
  /** Rua/avenida. null = não identificado. */
  logradouro: string | null;
  numero: string | null;
  bairro: string | null;
  cep: string | null;
  cidade: string | null;
  /** Sigla de 2 letras, ex.: "MG". */
  uf: string | null;
};

export type SugestaoEndereco = {
  /** Linha principal da sugestão (ex.: "Rua das Palmeiras, 120"). */
  mainText: string;
  /** Linha de contexto (ex.: "Santa Mônica, Uberlândia - MG"). */
  secondaryText: string;
  /** Endereço completo rótulo, usado para recalcular a rota. */
  label: string;
  components: AddressComponents;
  /** Coordenadas quando o provedor as devolve na busca (OSM); null no Google. */
  lat: number | null;
  lon: number | null;
  /** true quando o resultado não tem rua+número confirmados (pode ser aproximado). */
  aproximado: boolean;
};

export type DestinoResolvido = {
  label: string;
  components: AddressComponents;
  lat: number;
  lon: number;
  aproximado: boolean;
};

export type ProviderEndereco = "google" | "osm";

const componentesVazios: AddressComponents = {
  logradouro: null, numero: null, bairro: null, cep: null, cidade: null, uf: null,
};

/* ------------------------------- utilidades ------------------------------ */

const cepRegex = /^\d{5}-?\d{3}$/;

/** true quando a consulta é um CEP (com ou sem hífen). */
export function ehCep(consulta: string): boolean {
  return cepRegex.test(consulta.trim());
}

function normalizarCep(cep: string): string {
  const digitos = cep.replace(/\D/g, "");
  return digitos.length === 8 ? `${digitos.slice(0, 5)}-${digitos.slice(5)}` : cep.trim();
}

function normalizarUf(uf: string | null | undefined): string | null {
  if (!uf) return null;
  const limpo = uf.trim();
  return limpo.length === 2 ? limpo.toUpperCase() : null;
}

/** "Rua X, 125" (sem inventar o que não veio). */
export function formatarPrincipal(c: AddressComponents): string {
  const rua = c.logradouro?.trim();
  const numero = c.numero?.trim();
  if (rua && numero) return `${rua}, ${numero}`;
  if (rua) return rua;
  if (c.cidade) return c.cidade + (c.uf ? ` - ${c.uf}` : "");
  return "Endereço";
}

/** Contexto: "Bairro · Cidade - UF" ou "Cidade - UF"; vazio quando nada veio. */
export function formatarContexto(c: AddressComponents): string {
  const partes: string[] = [];
  if (c.bairro) partes.push(c.bairro);
  const cidadeUf = [c.cidade, c.uf].filter(Boolean).join(" - ");
  if (cidadeUf) partes.push(cidadeUf);
  if (c.cep) partes.push(`CEP ${c.cep}`);
  return partes.join(" · ");
}

/**
 * Rótulo completo usado no campo e recolocado no provedor para calcular a
 * rota — por isso é separado por vírgulas e sem ornamentos ("·", "CEP"): o
 * texto precisa ser geocodificável de volta, não só bonito de ler.
 */
export function formatarLabel(c: AddressComponents): string {
  const principal = formatarPrincipal(c);
  const meio = [c.bairro, [c.cidade, c.uf].filter(Boolean).join(" - ")].filter(Boolean).join(", ");
  const partes = [principal, meio, c.cep ?? null].filter(Boolean);
  return Array.from(new Set(partes)).join(", ");
}

/* --------------------------------- ViaCEP ------------------------------- */

export type DadosCep = {
  cep: string; logradouro: string; complemento: string; bairro: string;
  localidade: string; uf: string; erro?: boolean;
};

/**
 * Consulta o ViaCEP (serviço público gratuito dos Correios, sem credencial)
 * para transformar um CEP em endereço pesquisável. Retorna null quando o CEP
 * não existe ou o serviço falha — quem decide é quem chama.
 */
export async function buscarCep(cep: string, request: typeof fetch = fetch): Promise<DadosCep | null> {
  const digitos = cep.replace(/\D/g, "");
  if (digitos.length !== 8) return null;
  try {
    const response = await request(`https://viacep.com.br/ws/${digitos}/json/`, {
      signal: AbortSignal.timeout(8000), headers: { "Accept": "application/json" },
    });
    if (!response.ok) return null;
    const data = await response.json() as DadosCep & { erro?: boolean };
    if (data?.erro || !data?.localidade) return null;
    return data;
  } catch { return null; }
}

/* ------------------------------- Nominatim ------------------------------ */

type ItemNominatim = {
  lat?: string; lon?: string; display_name?: string; type?: string;
  address?: Record<string, string | undefined>;
};

/** Extrai os componentes brasileiros do objeto address do Nominatim. */
export function componentesDoNominatim(address: Record<string, string | undefined> | undefined): AddressComponents {
  const a = address ?? {};
  const logradouro = a.road || a.pedestrian || a.footway || a.cycleway || null;
  const bairro = a.suburb || a.neighbourhood || a.quarter || a.city_district || a.district || a.village || a.hamlet || null;
  const cidade = a.city || a.town || a.municipality || a.village || a.county || null;
  return {
    logradouro: logradouro || null,
    numero: a.house_number || null,
    bairro: bairro || null,
    cep: a.postcode ? normalizarCep(a.postcode) : null,
    cidade: cidade || null,
    uf: normalizarUf(a.state) ?? (a["ISO3166-2-lvl4"] ? a["ISO3166-2-lvl4"].slice(3) : null),
  };
}

function itemParaSugestao(item: ItemNominatim): SugestaoEndereco | null {
  const lat = Number(item.lat), lon = Number(item.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const components = componentesDoNominatim(item.address);
  // Sem rua nem cidade o resultado não ajuda o usuário a confirmar nada.
  if (!components.logradouro && !components.cidade) return null;
  const aproximado = !components.logradouro || !components.numero;
  return {
    mainText: formatarPrincipal(components),
    secondaryText: formatarContexto(components),
    label: components.logradouro ? formatarLabel(components) : (item.display_name ?? formatarLabel(components)),
    components, lat, lon, aproximado,
  };
}

/** Busca endereços no Nominatim (limitado ao Brasil, em português). */
export async function nominatimSearch(consulta: string, endpoint: string, request: typeof fetch = fetch): Promise<SugestaoEndereco[]> {
  const url = new URL("search", endpoint.endsWith("/") ? endpoint : endpoint + "/");
  url.search = new URLSearchParams({
    q: consulta.trim(), format: "jsonv2", countrycodes: "br", limit: "6",
    addressdetails: "1", "accept-language": "pt-BR",
  }).toString();
  const data = await mapJson(url, request) as ItemNominatim[];
  if (!Array.isArray(data)) return [];
  const sugestoes: SugestaoEndereco[] = [];
  for (const item of data) {
    const s = itemParaSugestao(item);
    if (s) sugestoes.push(s);
  }
  return sugestoes;
}

/* --------------------------------- Google -------------------------------- */

type ItemAutocomplete = {
  placePrediction?: {
    place?: string;
    text?: { text?: string };
    structuredFormat?: {
      mainText?: { text?: string };
      secondaryText?: { text?: string };
    };
  };
};

type ComponenteGoogle = { long_name?: string; short_name?: string; types?: string[] };

/** Converte address_components do Geocoding API em componentes brasileiros. */
export function componentesDoGoogle(componentes: ComponenteGoogle[] | undefined): AddressComponents {
  const find = (tipo: string) => componentes?.find(c => c.types?.includes(tipo));
  const logradouro = find("route")?.long_name ?? null;
  const numero = find("street_number")?.long_name ?? null;
  const bairro = find("neighborhood")?.long_name
    ?? find("sublocality_level_1")?.long_name
    ?? find("sublocality")?.long_name
    ?? null;
  const cepRaw = find("postal_code")?.long_name ?? null;
  const cidade = find("locality")?.long_name ?? find("administrative_area_level_2")?.long_name ?? null;
  const uf = normalizarUf(find("administrative_area_level_1")?.short_name ?? null);
  return {
    logradouro, numero, bairro,
    cep: cepRaw ? normalizarCep(cepRaw) : null,
    cidade, uf,
  };
}

/** Sugestões do Places API (New) Autocomplete, restrito ao Brasil. */
export async function googleAutocomplete(consulta: string, apiKey: string, request: typeof fetch = fetch): Promise<SugestaoEndereco[]> {
  const response = await request("https://places.googleapis.com/v1/places:autocomplete", {
    method: "POST",
    signal: AbortSignal.timeout(10000),
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": "suggestions.placePrediction.place,suggestions.placePrediction.text.text,suggestions.placePrediction.structuredFormat.mainText.text,suggestions.placePrediction.structuredFormat.secondaryText.text",
    },
    body: JSON.stringify({
      input: consulta.trim(),
      languageCode: "pt-BR",
      includedRegionCodes: ["br"],
    }),
  });
  if (response.status === 429) throw new RouteError("Limite do serviço de mapas atingido. Aguarde e tente novamente.", 429);
  if (!response.ok) throw new RouteError("Serviço de mapas indisponível. Use o valor manual ou tente mais tarde.", 503);
  const data = await response.json() as { suggestions?: ItemAutocomplete[] };
  const sugestoes: SugestaoEndereco[] = [];
  for (const item of data.suggestions ?? []) {
    const p = item.placePrediction;
    const label = p?.text?.text?.trim();
    if (!label) continue;
    const main = p?.structuredFormat?.mainText?.text?.trim() ?? label;
    const secondary = p?.structuredFormat?.secondaryText?.text?.trim() ?? "";
    // O autocomplete do Google não devolve coordenadas nem componentes: eles
    // vêm do Geocoding na resolução (1 chamada só quando o usuário escolhe).
    sugestoes.push({
      mainText: main,
      secondaryText: secondary,
      label,
      components: { ...componentesVazios },
      lat: null, lon: null,
      aproximado: false,
    });
  }
  return sugestoes;
}

/** Geocodificação (Google) de um endereço completo, com componentes. */
export async function googleGeocode(consulta: string, apiKey: string, request: typeof fetch = fetch): Promise<DestinoResolvido> {
  const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
  url.search = new URLSearchParams({ address: consulta.trim(), language: "pt-BR", region: "br" }).toString();
  const data = await mapJson(url, request) as { status?: string; results?: Array<{ formatted_address?: string; geometry?: { location?: { lat?: number; lng?: number } }; address_components?: ComponenteGoogle[] }> };
  if (data.status === "REQUEST_DENIED" || data.status === "OVER_QUERY_LIMIT") {
    throw new RouteError("Serviço de mapas indisponível ou sem permissão. Use o valor manual ou tente mais tarde.", 503);
  }
  const result = data.results?.[0];
  const lat = Number(result?.geometry?.location?.lat);
  const lon = Number(result?.geometry?.location?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new RouteError(`Endereço não encontrado: ${consulta}`);
  }
  const components = componentesDoGoogle(result?.address_components);
  const label = result?.formatted_address?.trim() || formatarLabel(components);
  return {
    label, components, lat, lon,
    aproximado: !components.logradouro || !components.numero,
  };
}

/* ------------------------------ orquestração ----------------------------- */

/**
 * Resolve o destino digitado em coordenadas + componentes, qual for o
 * provedor configurado. Consultas por CEP passam pelo ViaCEP para virar um
 * endereço pesquisável (o Nominatim, por exemplo, retorna lixo para "38408-000").
 */
export async function resolverDestino(
  consulta: string,
  provider: ProviderEndereco,
  opcoes: { googleKey?: string | null; nominatimUrl?: string | null },
  request: typeof fetch = fetch,
): Promise<DestinoResolvido> {
  const texto = consulta.trim();
  if (texto.length < 3) throw new RouteError("Informe o endereço de destino.");
  if (texto.length > 400) throw new RouteError("Endereço longo demais. Encurte a consulta.");

  if (ehCep(texto)) {
    const cep = await buscarCep(texto, request);
    if (cep) {
      const endereco = [cep.logradouro, cep.bairro, `${cep.localidade} - ${cep.uf}`].filter(Boolean).join(", ");
      try {
        const resolvido = await geocodificar(endereco, provider, opcoes, request);
        return {
          ...resolvido,
          label: formatarLabel({ ...resolvido.components, cep: normalizarCep(cep.cep) }),
          components: { ...resolvido.components, cep: normalizarCep(cep.cep), bairro: resolvido.components.bairro ?? (cep.bairro || null), uf: resolvido.components.uf ?? cep.uf },
        };
      } catch {
        // CEP existe mas o endereço não geocodificou: devolve o próprio CEP como
        // último recurso, marcado como aproximado — sem inventar coordenadas de rua.
        throw new RouteError(`CEP ${normalizarCep(cep.cep)} localizado (${cep.localidade} - ${cep.uf}), mas não foi possível calcular a rota a partir dele. Refine com rua e número.`);
      }
    }
    // CEP desconhecido no ViaCEP: tenta o provedor direto com o CEP.
  }

  return geocodificar(texto, provider, opcoes, request);
}

async function geocodificar(
  texto: string,
  provider: ProviderEndereco,
  opcoes: { googleKey?: string | null; nominatimUrl?: string | null },
  request: typeof fetch,
): Promise<DestinoResolvido> {
  if (provider === "google") {
    if (!opcoes.googleKey) throw new RouteError("Serviço de mapas não configurado para esta instância.", 503);
    return googleGeocode(texto, opcoes.googleKey, request);
  }
  const url = new URL("search", (opcoes.nominatimUrl ?? "https://nominatim.openstreetmap.org/").replace(/\/?$/, "/"));
  url.search = new URLSearchParams({
    q: texto, format: "jsonv2", countrycodes: "br", limit: "1", addressdetails: "1", "accept-language": "pt-BR",
  }).toString();
  const data = await mapJson(url, request) as ItemNominatim[];
  const item = Array.isArray(data) ? data[0] : null;
  const lat = Number(item?.lat), lon = Number(item?.lon);
  if (!item || !Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new RouteError(`Endereço não encontrado: ${texto}. Refine a busca ou informe rua, bairro, cidade e estado.`);
  }
  const components = componentesDoNominatim(item.address);
  // Regra histórica do produto: sem rua o endereço não é confirmável.
  if (!components.logradouro && !components.cidade) {
    throw new RouteError(`Endereço incompleto: ${texto}. Inclua rua e número.`);
  }
  return {
    label: components.logradouro ? formatarLabel(components) : (item.display_name ?? texto),
    components, lat, lon,
    aproximado: !components.logradouro || !components.numero,
  };
}

/** provedor efetivo a partir das variáveis de ambiente da aplicação. */
export function providerEndereco(googleKey: string | null | undefined): ProviderEndereco {
  return googleKey && googleKey.trim() ? "google" : "osm";
}
