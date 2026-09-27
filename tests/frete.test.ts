/** Formulas da calculadora de frete. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { arredondarComercial, calcularFrete, VIAGENS, type ParametrosFrete } from "../src/lib/freight.ts";

/** Configuracao do exemplo do enunciado: etanol 3,32, 10 km/L, R$0,50/km, 30%. */
const BASE: ParametrosFrete = {
  distanciaIdaKm: 15,
  tipo: "locacao",
  consumoKmPorLitro: 10,
  precoLitroCents: 332,
  custoPorKmCents: 50,
  pedagioCents: 0,
  maoDeObraCents: 0,
  margemPercent: 30,
  valorMinimoCents: 3000,
  arredondamentoCents: 500,
};

const com = (p: Partial<ParametrosFrete>) => calcularFrete({ ...BASE, ...p });

describe("numero de viagens", () => {
  it("frete comum e ida e volta", () => {
    assert.equal(VIAGENS.comum, 2);
    assert.equal(com({ tipo: "comum", distanciaIdaKm: 20 }).distanciaTotalKm, 40);
  });

  it("locacao sao quatro deslocamentos: entrega, volta, retirada e volta", () => {
    assert.equal(VIAGENS.locacao, 4);
    assert.equal(com({ tipo: "locacao", distanciaIdaKm: 15 }).distanciaTotalKm, 60);
  });

  it("locacao nunca calcula como ida e volta", () => {
    const locacao = com({ tipo: "locacao", distanciaIdaKm: 30 });
    const comum = com({ tipo: "comum", distanciaIdaKm: 30 });
    assert.equal(locacao.distanciaTotalKm, comum.distanciaTotalKm * 2);
  });
});

describe("combustivel e custo operacional", () => {
  it("exemplo do enunciado: 60 km, 10 km/L, R$ 3,32", () => {
    const r = com({ distanciaIdaKm: 15, tipo: "locacao" });
    assert.equal(r.distanciaTotalKm, 60);
    assert.equal(r.litros, 6);
    assert.equal(r.custoCombustivelCents, 1992); // 6 x 3,32
    assert.equal(r.custoOperacionalCents, 3000); // 60 x 0,50
    assert.equal(r.custoTotalCents, 4992);
  });

  it("consumo diferente muda o combustivel, nao o custo por km", () => {
    const eficiente = com({ consumoKmPorLitro: 15 });
    const sedento = com({ consumoKmPorLitro: 6 });
    assert.ok(eficiente.custoCombustivelCents < sedento.custoCombustivelCents);
    assert.equal(eficiente.custoOperacionalCents, sedento.custoOperacionalCents);
  });

  it("consumo invalido nao quebra a conta", () => {
    const r = com({ consumoKmPorLitro: 0 });
    assert.equal(r.litros, 0);
    assert.equal(r.custoCombustivelCents, 0);
    assert.equal(r.custoOperacionalCents, 3000);
  });

  it("preco do litro alterado vale so para aquele calculo", () => {
    const padrao = com({});
    const caro = com({ precoLitroCents: 350 });
    assert.equal(padrao.custoCombustivelCents, 1992);
    assert.equal(caro.custoCombustivelCents, 2100); // 6 x 3,50
  });
});

describe("pedagio e mao de obra", () => {
  it("pedagio entra no custo", () => {
    const sem = com({});
    const comPedagio = com({ pedagioCents: 1500 });
    assert.equal(comPedagio.custoTotalCents, sem.custoTotalCents + 1500);
    assert.ok(comPedagio.precoFinalCents > sem.precoFinalCents);
  });

  it("mao de obra entra no custo quando informada", () => {
    assert.equal(com({ maoDeObraCents: 5000 }).custoTotalCents, 4992 + 5000);
  });
});

describe("margem de lucro", () => {
  it("e margem sobre a venda, nao acrescimo sobre o custo", () => {
    // custo 5000, margem 30% -> 5000 / 0,70 = 7142,857 -> 7143
    const r = com({ custoPorKmCents: 0, precoLitroCents: 0, maoDeObraCents: 5000, margemPercent: 30 });
    assert.equal(r.custoTotalCents, 5000);
    assert.equal(r.precoCalculadoCents, 7143);
    assert.notEqual(r.precoCalculadoCents, 6500, "custo + 30% estaria errado");
  });

  it("o lucro obtido bate com a margem pedida", () => {
    const r = com({ custoPorKmCents: 0, precoLitroCents: 0, maoDeObraCents: 7000, margemPercent: 30 });
    const margemReal = (r.precoCalculadoCents - r.custoTotalCents) / r.precoCalculadoCents;
    assert.ok(Math.abs(margemReal - 0.3) < 0.001, `margem real ${margemReal}`);
  });

  it("margem zero cobra o custo", () => {
    assert.equal(com({ margemPercent: 0 }).precoCalculadoCents, 4992);
  });

  it("margem de 100% nao quebra a divisao", () => {
    const r = com({ margemPercent: 100 });
    assert.ok(Number.isFinite(r.precoCalculadoCents));
    assert.ok(r.precoCalculadoCents > r.custoTotalCents);
  });
});

describe("valor minimo", () => {
  it("frete curto cai no minimo configurado", () => {
    const r = com({ distanciaIdaKm: 1, valorMinimoCents: 3000 });
    assert.ok(r.precoCalculadoCents < 3000);
    assert.equal(r.aplicouMinimo, true);
    assert.equal(r.precoFinalCents, 3000);
  });

  it("frete longo usa o valor calculado", () => {
    const r = com({ distanciaIdaKm: 30, valorMinimoCents: 3000 });
    assert.equal(r.aplicouMinimo, false);
    assert.equal(r.precoFinalCents, r.precoCalculadoCents);
  });
});

describe("valor sugerido", () => {
  it("arredonda para cima ate o proximo multiplo", () => {
    assert.equal(arredondarComercial(7143, 500), 7500);
    assert.equal(arredondarComercial(7000, 500), 7000);
    assert.equal(arredondarComercial(7001, 500), 7500);
  });

  it("multiplo zero mantem o valor exato", () => {
    assert.equal(arredondarComercial(7143, 0), 7143);
  });

  it("nunca sugere menos do que o preco calculado", () => {
    for (const km of [1, 5, 10, 15, 30, 100]) {
      const r = com({ distanciaIdaKm: km });
      assert.ok(r.valorSugeridoCents >= r.precoFinalCents, `km ${km}`);
    }
  });
});

describe("cenarios pedidos", () => {
  const casos: { nome: string; params: Partial<ParametrosFrete>; kmTotal: number }[] = [
    { nome: "comum 10 km", params: { tipo: "comum", distanciaIdaKm: 10 }, kmTotal: 20 },
    { nome: "comum 30 km", params: { tipo: "comum", distanciaIdaKm: 30 }, kmTotal: 60 },
    { nome: "locacao 10 km", params: { tipo: "locacao", distanciaIdaKm: 10 }, kmTotal: 40 },
    { nome: "locacao 30 km", params: { tipo: "locacao", distanciaIdaKm: 30 }, kmTotal: 120 },
  ];

  for (const caso of casos) {
    it(caso.nome, () => {
      const r = com(caso.params);
      assert.equal(r.distanciaTotalKm, caso.kmTotal);
      assert.equal(r.custoOperacionalCents, caso.kmTotal * 50);
      assert.equal(r.custoCombustivelCents, Math.round((caso.kmTotal / 10) * 332));
      assert.ok(r.valorSugeridoCents >= r.valorMinimoCents);
      assert.ok(r.lucroEstimadoCents > 0);
    });
  }

  it("distancia decimal e aceita", () => {
    const r = com({ distanciaIdaKm: 15.5, tipo: "locacao" });
    assert.equal(r.distanciaTotalKm, 62);
  });

  it("distancia zero nao gera valor negativo", () => {
    const r = com({ distanciaIdaKm: 0 });
    assert.equal(r.custoTotalCents, 0);
    assert.equal(r.precoFinalCents, r.valorMinimoCents);
  });
});
