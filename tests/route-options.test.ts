/**
 * Opções de rota da calculadora: alternativas rodoviárias com geometria,
 * pelo OSRM (fallback OSM) e pela Google Routes API (mockados), e a ligação
 * distância rodoviária -> fórmula comercial existente.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { googleRouteOptions, roadRouteOptions, type Place } from "../src/lib/routes";
import { decodePolyline, encodePolyline } from "../src/lib/polyline";
import { priceRoadDistance, freightConfig } from "../src/lib/freight-config";
import { calcularFrete } from "../src/lib/freight";

const pontos: Place[] = [
  { label: "Base, Uberlândia - MG", lat: -18.9185, lon: -48.9409 },
  { label: "Destino, Belo Horizonte - MG", lat: -19.9167, lon: -43.9386 },
];

const settings = {
  freight_consumption: "10", freight_fuel_price_cents: "500", freight_cost_per_km_cents: "50",
  freight_margin_percent: "0", freight_minimum_cents: "0", freight_rounding_cents: "0",
  freight_labor_cents: "0", freight_comum_base_address: "Rua da Base 10, Uberlândia - MG",
};
const config = freightConfig(settings, "comum");

describe("opções de rota OSRM (mockado)", () => {
  it("devolve alternativas com distância, duração e geometria real", async () => {
    const geo = { type: "LineString", coordinates: [[-48.9409, -18.9185], [-46.5, -19.3], [-43.9386, -19.9167]] };
    const fetchMock = (async () => Response.json({
      code: "Ok",
      routes: [
        { legs: [{ distance: 616800 }], duration: 32880, geometry: geo },
        { legs: [{ distance: 644100 }], duration: 33600, geometry: geo },
      ],
    })) as unknown as typeof fetch;
    const opcoes = await roadRouteOptions(pontos, "https://osrm.test", fetchMock);
    assert.equal(opcoes.length, 2, "as duas alternativas são apresentadas");
    assert.ok(Math.abs(opcoes[0].totalKm - 616.8) < 0.01);
    assert.equal(opcoes[0].durationMin, 548);
    assert.ok(Math.abs(opcoes[1].totalKm - 644.1) < 0.01);
    assert.ok(opcoes[0].geometry.length > 0, "geometria codificada presente para o mapa");
    const pontosDecodificados = decodePolyline(opcoes[0].geometry);
    assert.equal(pontosDecodificados.length, 3);
    assert.ok(Math.abs(pontosDecodificados[0][0] + 18.9185) < 1e-4);
  });

  it("descarta alternativas com trechos inválidos e renumera o índice", async () => {
    const fetchMock = (async () => Response.json({
      code: "Ok",
      routes: [
        { legs: [{ distance: NaN }], duration: 60, geometry: "" },
        { legs: [{ distance: 101000 }], duration: 600, geometry: "" },
      ],
    })) as unknown as typeof fetch;
    const opcoes = await roadRouteOptions(pontos, "https://osrm.test", fetchMock);
    assert.equal(opcoes.length, 1);
    assert.equal(opcoes[0].index, 0);
    assert.ok(Math.abs(opcoes[0].totalKm - 101) < 0.01);
  });

  it("sem rota rodoviária o erro é claro (nunca linha reta)", async () => {
    const fetchMock = (async () => Response.json({ code: "NoRoute", routes: [] })) as unknown as typeof fetch;
    await assert.rejects(() => roadRouteOptions(pontos, "https://osrm.test", fetchMock), /rodoviária/);
  });
});

describe("opções de rota Google Routes (mockado)", () => {
  it("devolve principal + alternativas com polyline decodificável", async () => {
    const geometria = encodePolyline([[-18.9185, -48.9409], [-19.9167, -43.9386]]);
    let corpo: Record<string, unknown> = {};
    const fetchMock = (async (input: RequestInfo | URL, init?: RequestInit) => {
      corpo = JSON.parse(String(init?.body ?? "{}"));
      return Response.json({
        routes: [
          { distanceMeters: 616800, duration: "32880s", polyline: { encodedPolyline: geometria } },
          { distanceMeters: 644100, duration: "33600s", polyline: { encodedPolyline: geometria } },
        ],
      });
    }) as unknown as typeof fetch;
    const opcoes = await googleRouteOptions(pontos[0], pontos[1], "chave-teste", fetchMock);
    assert.equal(opcoes.length, 2);
    assert.ok(Math.abs(opcoes[0].totalKm - 616.8) < 0.01);
    assert.equal(opcoes[0].durationMin, 548);
    assert.equal(decodePolyline(opcoes[0].geometry).length, 2);
    assert.equal((corpo as { computeAlternativeRoutes?: boolean }).computeAlternativeRoutes, true, "alternativas são solicitadas explicitamente");
    assert.equal((corpo as { travelMode?: string }).travelMode, "DRIVE", "somente trajeto rodoviário");
  });

  it("ZERO_RESULTS e erro de permissão viram RouteError compreensível", async () => {
    const sem = (async () => Response.json({})) as unknown as typeof fetch;
    await assert.rejects(() => googleRouteOptions(pontos[0], pontos[1], "k", sem), /rodoviária/);
    const negado = (async () => Response.json({ errorMessage: "denied" }, { status: 403 })) as unknown as typeof fetch;
    await assert.rejects(() => googleRouteOptions(pontos[0], pontos[1], "k", negado), /indisponível|tente/i);
  });
});

describe("distância rodoviária alimenta a fórmula comercial existente", () => {
  it("cada alternativa gera o valor da MESMA fórmula, com a distância dela", () => {
    const rota1 = priceRoadDistance(616.8, "comum", config).valorSugeridoCents;
    const rota2 = priceRoadDistance(644.1, "comum", config).valorSugeridoCents;
    assert.ok(rota2 > rota1, "rota mais longa custa mais, pela regra de sempre");
    // priceRoadDistance só troca a FONTE da distância: o percurso total vira
    // ida (total/viagens) e a fórmula existente faz o resto.
    const manual = calcularFrete({
      tipo: "comum", distanciaIdaKm: 616.8 / 2, consumoKmPorLitro: config.consumption,
      precoLitroCents: config.fuelPriceCents, custoPorKmCents: config.costPerKmCents,
      pedagioCents: 0, maoDeObraCents: config.laborCents, margemPercent: config.marginPercent,
      valorMinimoCents: config.minimumCents, arredondamentoCents: config.roundingCents,
    });
    assert.equal(rota1, manual.valorSugeridoCents, "nenhuma multiplicação nova: só a origem do número mudou");
  });

  it("na calculadora, a distância da rota selecionada entra como IDA e as viagens multiplicam", () => {
    // Selecionada a Rota 2 (644,1 km de ida): quem multiplica é calcularFrete.
    const r = calcularFrete({
      tipo: "locacao", distanciaIdaKm: 644.1, consumoKmPorLitro: config.consumption,
      precoLitroCents: config.fuelPriceCents, custoPorKmCents: config.costPerKmCents,
      pedagioCents: 0, maoDeObraCents: config.laborCents, margemPercent: config.marginPercent,
      valorMinimoCents: config.minimumCents, arredondamentoCents: config.roundingCents,
    });
    assert.equal(r.viagens, 4);
    assert.ok(Math.abs(r.distanciaTotalKm - 2576.4) < 0.01, "locação: 4 viagens pela fórmula histórica");
  });
});
