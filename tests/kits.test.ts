/**
 * Regras de composicao (funcoes puras).
 *
 * Cenario base dos testes 1 a 6: 20 mesas, 80 cadeiras,
 * kit = 1 mesa + 4 cadeiras.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildSpecMap,
  computeConflicts,
  expandDemand,
  explodeLine,
  kitCapacity,
  unitsAvailable,
  validateComposition,
  type SpecMap,
} from "../src/lib/kits.ts";

const MESA = 1;
const CADEIRA = 2;
const KIT = 3;
const TENDA = 4;

const specs: SpecMap = buildSpecMap(
  [
    { id: MESA, name: "Mesa", kind: "simples" },
    { id: CADEIRA, name: "Cadeira", kind: "simples" },
    { id: KIT, name: "Kit Mesa + 4 Cadeiras", kind: "kit" },
    { id: TENDA, name: "Tenda", kind: "simples" },
  ],
  [
    { parent_product_id: KIT, component_product_id: MESA, quantity: 1 },
    { parent_product_id: KIT, component_product_id: CADEIRA, quantity: 4 },
  ],
);

const estoque = (mesas: number, cadeiras: number) =>
  new Map([
    [MESA, mesas],
    [CADEIRA, cadeiras],
  ]);

const restante = (mesas: number, cadeiras: number, linhas: { product_id: number; qty: number }[]) => {
  const consumo = expandDemand(linhas, specs);
  return {
    mesas: mesas - (consumo.get(MESA) ?? 0),
    cadeiras: cadeiras - (consumo.get(CADEIRA) ?? 0),
  };
};

describe("expansao de kits", () => {
  it("Teste 1 - 1 kit consome 1 mesa e 4 cadeiras", () => {
    assert.deepEqual(restante(20, 80, [{ product_id: KIT, qty: 1 }]), { mesas: 19, cadeiras: 76 });
  });

  it("Teste 2 - 5 kits consomem 5 mesas e 20 cadeiras", () => {
    assert.deepEqual(restante(20, 80, [{ product_id: KIT, qty: 5 }]), { mesas: 15, cadeiras: 60 });
  });

  it("Teste 3 - produtos individuais continuam funcionando normalmente", () => {
    const linhas = [
      { product_id: MESA, qty: 5 },
      { product_id: CADEIRA, qty: 10 },
    ];
    assert.deepEqual(restante(20, 80, linhas), { mesas: 15, cadeiras: 70 });
  });

  it("Teste 4 - mistura de kits com produtos individuais", () => {
    const linhas = [
      { product_id: KIT, qty: 3 },
      { product_id: MESA, qty: 5 },
      { product_id: CADEIRA, qty: 10 },
    ];
    // kits: 3 mesas + 12 cadeiras | individuais: 5 mesas + 10 cadeiras
    const consumo = expandDemand(linhas, specs);
    assert.equal(consumo.get(MESA), 8);
    assert.equal(consumo.get(CADEIRA), 22);
    assert.deepEqual(restante(20, 80, linhas), { mesas: 12, cadeiras: 58 });
  });

  it("produto individual nao gera consumo de outros produtos", () => {
    assert.deepEqual(explodeLine({ product_id: MESA, qty: 5 }, specs), [{ product_id: MESA, qty: 5 }]);
    const consumo = expandDemand([{ product_id: CADEIRA, qty: 10 }], specs);
    assert.equal(consumo.get(MESA), undefined);
    assert.equal(consumo.get(CADEIRA), 10);
  });
});

describe("disponibilidade do kit", () => {
  it("Teste 6 - 15 mesas e 58 cadeiras dao 14 kits (arredonda para baixo)", () => {
    assert.equal(kitCapacity(specs.get(KIT)!, estoque(15, 58)), 14);
  });

  it("20 mesas e 80 cadeiras dao exatamente 20 kits", () => {
    assert.equal(kitCapacity(specs.get(KIT)!, estoque(20, 80)), 20);
  });

  it("o componente mais escasso limita o kit", () => {
    assert.equal(kitCapacity(specs.get(KIT)!, estoque(100, 7)), 1);
    assert.equal(kitCapacity(specs.get(KIT)!, estoque(0, 400)), 0);
  });

  it("produto simples reporta a propria disponibilidade", () => {
    assert.equal(unitsAvailable(specs.get(MESA), estoque(15, 58)), 15);
  });
});

describe("validacao de estoque", () => {
  it("Teste 5 - 3 kits com 3 mesas e 10 cadeiras deve bloquear", () => {
    const conflitos = computeConflicts([{ product_id: KIT, qty: 3 }], specs, estoque(3, 10));
    assert.equal(conflitos.length, 1);
    assert.equal(conflitos[0].kind, "kit");
    assert.equal(conflitos[0].requested, 3);
    // min(floor(3/1), floor(10/4)) = 2
    assert.equal(conflitos[0].available, 2);
    assert.equal(conflitos[0].missing, 1);
    const faltando = conflitos[0].components.map((c) => c.product);
    assert.deepEqual(faltando, ["Cadeira"]);
  });

  it("nao acusa conflito quando cabe no estoque", () => {
    assert.equal(computeConflicts([{ product_id: KIT, qty: 20 }], specs, estoque(20, 80)).length, 0);
    assert.equal(
      computeConflicts(
        [
          { product_id: KIT, qty: 3 },
          { product_id: MESA, qty: 5 },
          { product_id: CADEIRA, qty: 10 },
        ],
        specs,
        estoque(20, 80),
      ).length,
      0,
    );
  });

  it("o disponivel do kit considera as demais linhas do mesmo pedido", () => {
    // 20 cadeiras no total; 10 ja pedidas soltas deixam 10 -> cabem 2 kits
    const conflitos = computeConflicts(
      [
        { product_id: KIT, qty: 5 },
        { product_id: CADEIRA, qty: 10 },
      ],
      specs,
      estoque(20, 20),
    );
    const kit = conflitos.find((c) => c.product_id === KIT);
    assert.ok(kit);
    assert.equal(kit!.available, 2);
  });

  it("acusa o produto individual que ficou sem estoque", () => {
    const conflitos = computeConflicts([{ product_id: MESA, qty: 30 }], specs, estoque(20, 80));
    assert.equal(conflitos.length, 1);
    assert.equal(conflitos[0].kind, "simples");
    assert.equal(conflitos[0].available, 20);
    assert.equal(conflitos[0].missing, 10);
  });
});

describe("validacao da composicao", () => {
  it("recusa kit sem componentes", () => {
    assert.match(validateComposition(null, [], specs) ?? "", /ao menos um componente/i);
  });

  it("recusa quantidade zero ou negativa", () => {
    assert.ok(validateComposition(null, [{ product_id: MESA, quantity: 0 }], specs));
    assert.ok(validateComposition(null, [{ product_id: MESA, quantity: -2 }], specs));
  });

  it("recusa produto componente de si mesmo", () => {
    assert.match(
      validateComposition(MESA, [{ product_id: MESA, quantity: 1 }], specs) ?? "",
      /componente de si mesmo/i,
    );
  });

  it("recusa kit dentro de kit, o que impede composicao circular", () => {
    assert.match(validateComposition(null, [{ product_id: KIT, quantity: 1 }], specs) ?? "", /kits dentro de kits/i);
  });

  it("aceita composicao valida com varios componentes", () => {
    assert.equal(
      validateComposition(
        null,
        [
          { product_id: MESA, quantity: 2 },
          { product_id: CADEIRA, quantity: 8 },
          { product_id: TENDA, quantity: 1 },
        ],
        specs,
      ),
      null,
    );
  });
});
