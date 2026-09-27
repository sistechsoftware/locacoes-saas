/**
 * Busca dinamica nas selecoes (clientes e reservas).
 *
 * Regressao do bug anterior: ao digitar progressivamente "1", "12", "123"... na
 * busca por CPF, o mesmo cliente aparecia varias vezes. Aqui a deduplicacao e
 * testada em cada etapa da digitacao, junto com a tolerancia de nome (acentos,
 * maiusculas, espacos) e a busca por numero de reserva.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { filtrarOpcoes, normalizarTexto, digitosDe, opcaoCorresponde, unicosPorId, type OpcaoSelecionavel } from "../src/lib/search-select-utils.ts";

/** Cliente do cenario, no formato das opcoes que as telas montam. */
const cliente = (id: number, name: string, doc: string, phone = "", reservas: string[] = []): OpcaoSelecionavel => ({
  value: String(id),
  label: name,
  digitos: [doc, phone, ...reservas.map((r) => r.replace(/\D/g, ""))],
});

const JOAO = cliente(1, "João da Silva", "123.456.789-09", "(11) 96666-5555", ["LIMA-001", "LIMA-010"]);
const MARIA = cliente(2, "Maria de Souza", "987.654.321-00", "", ["LIMA-002"]);
const PEDRO = cliente(3, "Pedro Álvares", "111.222.333-44");
const OUTRO = cliente(4, "Ana Maria Braga", "555.444.333-22");

const TODOS = [JOAO, MARIA, PEDRO, OUTRO];

describe("normalizacao", () => {
  it("remove acentos, maiusculas e espacos extras sem alterar o original", () => {
    assert.equal(normalizarTexto("  JOÃO   DA   Silva "), "joao da silva");
    assert.equal(normalizarTexto("ÁÁÁéê"), "aaaee");
    assert.equal(normalizarTexto(null), "");
  });

  it("mantem apenas digitos para CPF/telefone/numero", () => {
    assert.equal(digitosDe("123.456.789-09"), "12345678909");
    assert.equal(digitosDe("(11) 91234-5678"), "11912345678");
    assert.equal(digitosDe("LIMA-010"), "010");
  });
});

describe("REGRESSAO: digitação progressiva de CPF nunca duplica cliente", () => {
  const etapas = ["1", "12", "123", "1234", "12345", "123456", "1234567", "12345678", "123456789", "12345678909"];

  for (const termo of etapas) {
    it(`CPF "${termo}": Joao aparece exatamente uma vez e ninguem duplica`, () => {
      const r = filtrarOpcoes(TODOS, termo);
      const joaos = r.filter((x) => x.value === "1");
      assert.equal(joaos.length, 1, `esperado 1 Joao, veio ${joaos.length}`);
      const unicos = new Set(r.map((x) => x.value));
      assert.equal(unicos.size, r.length, `duplicado no termo "${termo}"`);
      // a partir de "123" a sequencia e exclusiva do CPF do Joao
      if (termo.length >= 3) assert.deepEqual(r.map((x) => x.value), ["1"]);
    });
  }

  it("CPF com pontuacao encontra o mesmo cliente", () => {
    assert.deepEqual(filtrarOpcoes(TODOS, "123.456").map((x) => x.value), ["1"]);
    assert.deepEqual(filtrarOpcoes(TODOS, "123.456.789-09").map((x) => x.value), ["1"]);
  });

  it("apagar caracteres volta a ampliar os resultados, sem duplicar", () => {
    // digita ate o CPF completo e vai apagando
    let termo = "12345678909";
    for (; termo.length >= 1; termo = termo.slice(0, -1)) {
      const r = filtrarOpcoes(TODOS, termo);
      const unicos = new Set(r.map((x) => x.value));
      assert.equal(unicos.size, r.length, `duplicado no termo "${termo}"`);
      assert.ok(r.some((x) => x.value === "1"), `Joao sumiu no termo "${termo}"`);
    }
  });

  it("sequencias que pertencem a mais de um cliente trazem ambos, uma vez cada", () => {
    // "1" esta no CPF do Joao (123...), da Maria (...32100) e do Pedro (111...)
    const r = filtrarOpcoes(TODOS, "1");
    assert.deepEqual(new Set(r.map((x) => x.value)), new Set(["1", "2", "3"]));
    assert.equal(r.length, 3);
  });
});

describe("REGRESSAO: filtro por nome funciona e e tolerante", () => {
  it("J, JO, JOA, JOAO encontram Joao em todas as etapas", () => {
    for (const termo of ["J", "JO", "JOA", "JOAO", "joao", "João", "JOÃO"]) {
      const r = filtrarOpcoes(TODOS, termo);
      assert.ok(r.some((x) => x.value === "1"), `"${termo}" deveria achar Joao`);
      const unicos = new Set(r.map((x) => x.value));
      assert.equal(unicos.size, r.length);
    }
  });

  it("primeiro nome e sobrenome, em qualquer ordem", () => {
    assert.deepEqual(filtrarOpcoes(TODOS, "joão").map((x) => x.value), ["1"]);
    assert.deepEqual(filtrarOpcoes(TODOS, "silva").map((x) => x.value), ["1"]);
    assert.deepEqual(filtrarOpcoes(TODOS, "silva joao").map((x) => x.value), ["1"]);
  });

  it("nome composto compartilhado aparece nos dois, sem duplicar", () => {
    // "maria" esta em Maria de Souza e Ana Maria Braga
    const r = filtrarOpcoes(TODOS, "maria");
    assert.deepEqual(new Set(r.map((x) => x.value)), new Set(["2", "4"]));
    assert.equal(r.length, 2);
  });

  it("sem acento encontra com acento", () => {
    assert.deepEqual(filtrarOpcoes(TODOS, "alvares").map((x) => x.value), ["3"]);
    assert.deepEqual(filtrarOpcoes(TODOS, "joao da silva").map((x) => x.value), ["1"]);
  });

  it("nome inexistente devolve lista vazia", () => {
    assert.equal(filtrarOpcoes(TODOS, "zezinio").length, 0);
  });

  it("termo vazio nao filtra nada (lista inteira, unica)", () => {
    const r = filtrarOpcoes(TODOS, "");
    assert.equal(r.length, TODOS.length);
  });
});

describe("REGRESSAO: busca de reserva por numero", () => {
  const opcoesReserva: OpcaoSelecionavel[] = [
    { value: "1", label: "LIMA-001 - Joao (2026-09-15)", digitos: ["001"] },
    { value: "10", label: "LIMA-010 - Maria (2026-09-20)", digitos: ["010"] },
    { value: "102", label: "LIMA-102 - Pedro (2026-09-25)", digitos: ["102"] },
    { value: "1025", label: "LIMA-1025 - Ana (2026-09-30)", digitos: ["1025"] },
  ];

  for (const termo of ["1", "10", "102", "1025", "LIMA-1025", "lima"]) {
    it(`"${termo}" acha o numero certo, uma unica vez`, () => {
      const r = filtrarOpcoes(opcoesReserva, termo);
      const unicos = new Set(r.map((x) => x.value));
      assert.equal(unicos.size, r.length, `duplicado no termo "${termo}"`);
      assert.ok(r.length > 0, `"${termo}" deveria achar algo`);
    });
  }

  it("progressao 1 -> 10 -> 102 -> 1025 mantem o conjunto correto", () => {
    // "001" contem "1" (mas nao "10"); "010" e "102" contem "10"; e assim vai
    assert.deepEqual(new Set(filtrarOpcoes(opcoesReserva, "1").map((x) => x.value)), new Set(["1", "10", "102", "1025"]));
    assert.deepEqual(new Set(filtrarOpcoes(opcoesReserva, "10").map((x) => x.value)), new Set(["10", "102", "1025"]));
    assert.deepEqual(new Set(filtrarOpcoes(opcoesReserva, "102").map((x) => x.value)), new Set(["102", "1025"]));
    assert.deepEqual(new Set(filtrarOpcoes(opcoesReserva, "1025").map((x) => x.value)), new Set(["1025"]));
  });

  it("reserva inexistente devolve vazio e nao quebra", () => {
    assert.equal(filtrarOpcoes(opcoesReserva, "999").length, 0);
  });

  it("cliente com varias reservas: nome acha as reservas dele, cada uma uma vez", () => {
    const reservasDeJoao: OpcaoSelecionavel[] = [
      { value: "1", label: "LIMA-001 - Joao da Silva", digitos: ["001"] },
      { value: "10", label: "LIMA-010 - Joao da Silva", digitos: ["010"] },
      { value: "2", label: "LIMA-002 - Maria", digitos: ["002"] },
    ];
    const r = filtrarOpcoes(reservasDeJoao, "joao");
    assert.deepEqual(new Set(r.map((x) => x.value)), new Set(["1", "10"]));
    assert.equal(r.length, 2);
  });
});

describe("deduplicacao estrutural", () => {
  it("entrada com linhas repetidas sai unica por id, antes mesmo do filtro", () => {
    const duplicado = [JOAO, JOAO, MARIA, JOAO, PEDRO, MARIA];
    const r = filtrarOpcoes(duplicado, "");
    assert.deepEqual(r.map((x) => x.value), ["1", "2", "3"]);
  });

  it("unicosPorId preserva a primeira ocorrencia e a ordem", () => {
    const linhas = [
      { id: 7, tag: "a" },
      { id: 7, tag: "b" },
      { id: 8, tag: "c" },
      { id: 8, tag: "d" },
    ];
    const r = unicosPorId(linhas, (x) => x.id);
    assert.deepEqual(r.map((x) => x.tag), ["a", "c"]);
  });

  it("unicosPorId nao descarta linha sem chave", () => {
    const linhas: { id: number | null }[] = [{ id: 1 }, { id: null }, { id: 1 }];
    assert.equal(unicosPorId(linhas, (x) => x.id).length, 2);
  });

  it("mesma entrada em chamadas repetidas devolve SEMPRE a mesma saida (determinismo)", () => {
    const a = filtrarOpcoes(TODOS, "1");
    const b = filtrarOpcoes(TODOS, "1");
    const c = filtrarOpcoes(TODOS, "1");
    assert.deepEqual(a, b);
    assert.deepEqual(b, c);
  });

  it("opcaoCorresponde exige todos os tokens (nome completo parcial)", () => {
    const op = cliente(9, "Maria Silva", "999.888.777-66");
    assert.equal(opcaoCorresponde(op, "maria"), true);
    assert.equal(opcaoCorresponde(op, "silva maria"), true);
    assert.equal(opcaoCorresponde(op, "maria pedro"), false);
  });
});
