/**
 * Busca de endereços da calculadora de frete (Menu + > Calcular Frete).
 *
 * Respostas MOCKADAS dos provedores (Nominatim, ViaCEP, Google) na matriz
 * nacional das cinco regiões — nenhum teste depende de serviço externo.
 * Cada cenário avalia separadamente: endereço encontrado, dados de
 * identificação disponíveis, coordenadas coerentes e erros tratados.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buscarCep, ehCep, formatarContexto, formatarLabel, formatarPrincipal,
  componentesDoGoogle, componentesDoNominatim,
  googleAutocomplete, googleGeocode, nominatimSearch, providerEndereco, resolverDestino,
  type SugestaoEndereco,
} from "../src/lib/address-search";

/** Monta um fetch mockado que responde JSON com status 200. */
const respostas = (...corpos: unknown[]): typeof fetch =>
  (async () => Response.json(corpos.shift())) as unknown as typeof fetch;

describe("utilidades de endereço", () => {
  it("reconhece CEP com e sem hígen e outros formatos", () => {
    assert.ok(ehCep("38408-000"));
    assert.ok(ehCep("38408000"));
    assert.ok(!ehCep("Rua das Flores, 120"));
    assert.ok(!ehCep("3840-00"));
  });
  it("monta rótulos sem inventar componente ausente", () => {
    assert.equal(formatarPrincipal({ logradouro: "Rua X", numero: "125", bairro: null, cep: null, cidade: null, uf: null }), "Rua X, 125");
    assert.equal(formatarPrincipal({ logradouro: null, numero: null, bairro: null, cep: null, cidade: "Uberlândia", uf: "MG" }), "Uberlândia - MG");
    assert.equal(formatarContexto({ logradouro: null, numero: null, bairro: "Santa Mônica", cep: "38408-000", cidade: "Uberlândia", uf: "MG" }), "Santa Mônica · Uberlândia - MG · CEP 38408-000");
    assert.equal(formatarLabel({ logradouro: "Rua X", numero: null, bairro: null, cep: null, cidade: null, uf: null }), "Rua X");
  });
  it("provedor: chave google presente => google; sem chave => osm", () => {
    assert.equal(providerEndereco("AIzaxyz"), "google");
    assert.equal(providerEndereco(""), "osm");
    assert.equal(providerEndereco(null), "osm");
    assert.equal(providerEndereco("   "), "osm");
  });
});

/* ------------------------- matriz nacional (mocks) ------------------------ */

describe("matriz nacional — Nominatim (mockado)", () => {
  const nom = (address: Record<string, string | undefined>, lat: string, lon: string, display = "X") =>
    ({ lat, lon, display_name: display, address });

  it("Norte (Manaus-AM): rua, número, bairro, CEP, cidade e UF identificados", async () => {
    const sugestoes = await nominatimSearch("Avenida Presidente Vargas, 1000, Manaus", "https://geo.test", respostas([
      nom({ road: "Avenida Presidente Vargas", house_number: "1000", suburb: "Centro", postcode: "69005-070", city: "Manaus", state: "Amazonas", "ISO3166-2-lvl4": "BR-AM" }, "-3.133", "-60.023"),
    ]));
    assert.equal(sugestoes.length, 1);
    const s = sugestoes[0];
    assert.equal(s.components.logradouro, "Avenida Presidente Vargas");
    assert.equal(s.components.numero, "1000");
    assert.equal(s.components.bairro, "Centro");
    assert.equal(s.components.cep, "69005-070");
    assert.equal(s.components.cidade, "Manaus");
    assert.equal(s.components.uf, "AM");
    assert.equal(s.aproximado, false);
    assert.ok(Number.isFinite(s.lat) && Number.isFinite(s.lon), "coordenadas presentes");
  });

  it("Nordeste (Fortaleza-CE): correspondências ambíguas se diferenciam por bairro e CEP", async () => {
    const sugestoes = await nominatimSearch("Avenida Beira Mar, 1000, Fortaleza", "https://geo.test", respostas([
      nom({ road: "Avenida Beira Mar", suburb: "Meireles", postcode: "60165-120", city: "Fortaleza", state: "Ceará", "ISO3166-2-lvl4": "BR-CE" }, "-3.7257", "-38.4968"),
      nom({ road: "Avenida Beira Mar", suburb: "Mucuripe", postcode: "60165-121", city: "Fortaleza", state: "Ceará", "ISO3166-2-lvl4": "BR-CE" }, "-3.7233", "-38.4876"),
      nom({ road: "Avenida Beira Mar", suburb: "Cais do Porto", postcode: "60165-121", city: "Fortaleza", state: "Ceará", "ISO3166-2-lvl4": "BR-CE" }, "-3.7218", "-38.4789"),
    ]));
    assert.equal(sugestoes.length, 3, "todas as opções são apresentadas");
    const bairros = new Set(sugestoes.map(s => s.components.bairro));
    assert.deepEqual([...bairros].sort(), ["Cais do Porto", "Meireles", "Mucuripe"]);
    // sem número na resposta => marcado como aproximado, nunca confirmado
    assert.ok(sugestoes.every(s => s.aproximado));
    // opções distinguíveis: mesmo logradouro, contexto diferente
    assert.ok(new Set(sugestoes.map(s => formatarContexto(s.components))).size === 3);
  });

  it("Sudeste (Uberlândia-MG): duas ruas iguais em bairros diferentes distinguem-se", async () => {
    const sugestoes = await nominatimSearch("Rua Exemplo, 125, Uberlândia", "https://geo.test", respostas([
      nom({ road: "Rua Exemplo", house_number: "125", suburb: "Santa Mônica", postcode: "38408-000", city: "Uberlândia", state: "Minas Gerais", "ISO3166-2-lvl4": "BR-MG" }, "-18.931", "-48.970"),
      nom({ road: "Rua Exemplo", house_number: "125", suburb: "Tibery", postcode: "38405-000", city: "Uberlândia", state: "Minas Gerais", "ISO3166-2-lvl4": "BR-MG" }, "-18.918", "-48.924"),
    ]));
    assert.equal(sugestoes.length, 2);
    assert.equal(sugestoes[0].components.bairro, "Santa Mônica");
    assert.equal(sugestoes[1].components.bairro, "Tibery");
    assert.notEqual(sugestoes[0].components.cep, sugestoes[1].components.cep);
    assert.ok(sugestoes.every(s => !s.aproximado), "rua+número presentes = não aproximado");
  });

  it("Centro-Oeste (Brasília-DF): bairro e UF extraídos via sigla ISO", async () => {
    const sugestoes = await nominatimSearch("SHIS QI 11, Lago Sul, Brasília", "https://geo.test", respostas([
      nom({ road: "SHIS QI 11", suburb: "Lago Sul", postcode: "71625-205", city: "Brasília", state: "Distrito Federal", "ISO3166-2-lvl4": "BR-DF" }, "-15.824", "-47.866"),
    ]));
    assert.equal(sugestoes[0].components.uf, "DF");
    assert.equal(sugestoes[0].components.bairro, "Lago Sul");
  });

  it("Sul (Curitiba-PR): endereço sem número vem marcado como aproximado", async () => {
    const sugestoes = await nominatimSearch("Rua XV de Novembro, Curitiba", "https://geo.test", respostas([
      nom({ road: "Rua XV de Novembro", suburb: "Centro", postcode: "80020-310", city: "Curitiba", state: "Paraná", "ISO3166-2-lvl4": "BR-PR" }, "-25.430", "-49.273"),
    ]));
    assert.equal(sugestoes.length, 1);
    assert.equal(sugestoes[0].components.numero, null);
    assert.ok(sugestoes[0].aproximado, "sem número = aproximado");
  });

  it("sem resultado devolve lista vazia; cidade sem rua vira opção aproximada sinalizada", async () => {
    assert.deepEqual(await nominatimSearch("Rua Inexistente XYZ", "https://geo.test", respostas([])), []);
    const semRua = await nominatimSearch("São Paulo", "https://geo.test", respostas([
      nom({ city: "São Paulo", state: "São Paulo", "ISO3166-2-lvl4": "BR-SP" }, "-23.55", "-46.63"),
    ]));
    assert.equal(semRua.length, 1, "correspondência parcial NÃO é escondida do usuário");
    assert.equal(semRua[0].components.logradouro, null);
    assert.ok(semRua[0].aproximado, "mas fica marcada como aproximada");
  });

  it("falha do provedor vira RouteError compreensível (não exceção solta)", async () => {
    await assert.rejects(
      () => nominatimSearch("Rua X, 10", "https://geo.test", (() => { throw new Error("offline"); }) as unknown as typeof fetch),
      /conectar|inválida/i,
    );
  });
});

/* --------------------------------- CEP ---------------------------------- */

describe("pesquisa por CEP (ViaCEP + geocodificação)", () => {
  const viaCep = { cep: "90010-150", logradouro: "Rua dos Andradas", complemento: "", bairro: "Centro", localidade: "Porto Alegre", uf: "RS" };

  it("CEP do Sul vira endereço completo e mantém o CEP no resultado", async () => {
    const fetchMock = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("viacep")) return Response.json(viaCep);
      return Response.json([{
        lat: "-30.035", lon: "-51.226",
        display_name: "Rua dos Andradas, Centro, Porto Alegre",
        address: { road: "Rua dos Andradas", house_number: "320", suburb: "Centro", postcode: "90010-150", city: "Porto Alegre", state: "Rio Grande do Sul", "ISO3166-2-lvl4": "BR-RS" },
      }]);
    }) as unknown as typeof fetch;
    const resolvido = await resolverDestino("90010-150", "osm", { nominatimUrl: "https://geo.test" }, fetchMock);
    assert.equal(resolvido.components.cep, "90010-150");
    assert.equal(resolvido.components.cidade, "Porto Alegre");
    assert.equal(resolvido.components.uf, "RS");
    assert.ok(Number.isFinite(resolvido.lat) && Number.isFinite(resolvido.lon));
  });

  it("CEP inexistente não quebra: cai na geocodificação do provedor", async () => {
    const fetchMock = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("viacep")) return Response.json({ erro: true });
      return Response.json([{
        lat: "-15.79", lon: "-47.88",
        display_name: "Quadra 101, Brasília",
        address: { road: "Quadra 101", suburb: "Asa Sul", postcode: "70297-400", city: "Brasília", state: "Distrito Federal", "ISO3166-2-lvl4": "BR-DF" },
      }]);
    }) as unknown as typeof fetch;
    const resolvido = await resolverDestino("70297-400", "osm", { nominatimUrl: "https://geo.test" }, fetchMock);
    assert.equal(resolvido.components.cidade, "Brasília");
  });

  it("falha do ViaCEP é tratada sem lançar", async () => {
    const fetchMock = (() => { throw new Error("timeout"); }) as unknown as typeof fetch;
    assert.equal(await buscarCep("01000-000", fetchMock), null);
  });
});

/* -------------------------------- Google --------------------------------- */

describe("Google: autocomplete e geocodificação (mockados)", () => {
  it("autocomplete devolve sugestões com linhas principal/secundária e SEM coordenadas", async () => {
    const sugestoes = await googleAutocomplete("Rua das Palmeiras 120", "chave-teste", respostas({
      suggestions: [
        { placePrediction: { place: "places/abc", text: { text: "Rua das Palmeiras, 120, Uberlândia - MG" }, structuredFormat: { mainText: { text: "Rua das Palmeiras, 120" }, secondaryText: { text: "Santa Mônica, Uberlândia - MG" } } } },
        { placePrediction: { place: "places/def", text: { text: "Rua das Palmeiras, São Paulo - SP" }, structuredFormat: { mainText: { text: "Rua das Palmeiras" }, secondaryText: { text: "São Paulo - SP" } } } },
      ],
    }));
    assert.equal(sugestoes.length, 2);
    assert.equal(sugestoes[0].mainText, "Rua das Palmeiras, 120");
    assert.equal(sugestoes[0].secondaryText, "Santa Mônica, Uberlândia - MG");
    assert.equal(sugestoes[0].lat, null, "autocomplete não devolve coordenadas");
  });

  it("geocoding extraí logradouro, número, bairro, CEP, cidade e UF", async () => {
    const resolvido = await googleGeocode("Rua das Palmeiras, 120, Uberlândia - MG", "chave-teste", respostas({
      status: "OK",
      results: [{
        formatted_address: "Rua das Palmeiras, 120 - Santa Mônica, Uberlândia - MG, 38408-000, Brasil",
        geometry: { location: { lat: -18.9315, lng: -48.9702 } },
        address_components: [
          { long_name: "Rua das Palmeiras", types: ["route"] },
          { long_name: "120", types: ["street_number"] },
          { long_name: "Santa Mônica", types: ["neighborhood"] },
          { long_name: "38408-000", types: ["postal_code"] },
          { long_name: "Uberlândia", types: ["locality"] },
          { long_name: "MG", short_name: "MG", types: ["administrative_area_level_1"] },
        ],
      }],
    }));
    assert.deepEqual(resolvido.components, {
      logradouro: "Rua das Palmeiras", numero: "120", bairro: "Santa Mônica",
      cep: "38408-000", cidade: "Uberlândia", uf: "MG",
    });
    assert.equal(resolvido.aproximado, false);
    assert.ok(Math.abs(resolvido.lat + 18.9315) < 1e-6);
  });

  it("componente ausente vira null (não identificado), sem invenção", () => {
    const c = componentesDoGoogle([{ long_name: "Uberlândia", types: ["locality"] }]);
    assert.equal(c.logradouro, null);
    assert.equal(c.numero, null);
    assert.equal(c.bairro, null);
    assert.equal(c.cep, null);
    assert.equal(c.cidade, "Uberlândia");
  });

  it("geocoding sem resultado e com permissão negada geram erros claros", async () => {
    await assert.rejects(() => googleGeocode("Rua Inexistente 1, Centro", "chave", respostas({ status: "ZERO_RESULTS", results: [] })), /não encontrado/);
    await assert.rejects(() => googleGeocode("Rua X, 10", "chave", respostas({ status: "REQUEST_DENIED", results: [] })), /indisponível|permissão/);
  });

  it("resolverDestino recusa Google sem chave configurada", async () => {
    await assert.rejects(() => resolverDestino("Rua das Palmeiras, 120, Uberlândia - MG", "google", { googleKey: "" }), /não configurado/);
  });

  it("consulta curta é recusada antes de chamar o provedor", async () => {
    await assert.rejects(() => resolverDestino("ru", "osm", { nominatimUrl: "https://geo.test" }), /destino/);
  });
});

describe("componentes do Nominatim", () => {
  it("aceita variações brasileiras (avenida, travessa, vila) sem quebrar", () => {
    const c1 = componentesDoNominatim({ pedestrian: "Calçada Central", city: "Recife", state: "Pernambuco", "ISO3166-2-lvl4": "BR-PE" });
    assert.equal(c1.logradouro, "Calçada Central");
    assert.equal(c1.uf, "PE");
    const c2 = componentesDoNominatim(undefined);
    assert.equal(c2.logradouro, null);
    assert.equal(c2.cidade, null);
  });
});

// Guarda de sanidade: o tipo exportado continua sendo o contrato da API.
const _contrato: SugestaoEndereco = {
  mainText: "", secondaryText: "", label: "",
  components: { logradouro: null, numero: null, bairro: null, cep: null, cidade: null, uf: null },
  lat: null, lon: null, aproximado: false,
};
void _contrato;
