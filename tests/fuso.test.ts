/**
 * Datas do negocio no fuso de Sao Paulo.
 *
 * O Worker roda em UTC. Sem tratamento, depois das 21h no horario de Brasilia
 * o sistema ja considerava o dia seguinte, e uma retirada de amanha aparecia
 * como "hoje". Estes testes rodam com o processo em UTC de proposito.
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { addDays, dateBR, dateUtcBR, endOfMonth, nowLocal, parseMoney, startOfWeek, toISODate, today, utcParaLocal, valorValido } from "../src/lib/format.ts";

describe("datas no fuso do negocio", () => {
  before(() => {
    // reproduz o ambiente do Worker
    process.env.TZ = "UTC";
  });

  it("22:30 de 04/09 em Brasilia ainda e dia 04, mesmo sendo 01:30 UTC do dia 05", () => {
    // 2026-09-05T01:30Z equivale a 2026-09-04 22:30 em Sao Paulo
    const instante = new Date("2026-09-05T01:30:00Z");
    assert.equal(toISODate(instante), "2026-09-04");
  });

  it("02:00 UTC vira 23:00 do dia anterior", () => {
    assert.equal(utcParaLocal("2026-09-05 02:00"), "04/09/2026 23:00");
  });

  it("meio-dia UTC continua no mesmo dia, tres horas antes", () => {
    assert.equal(toISODate(new Date("2026-09-04T12:00:00Z")), "2026-09-04");
    assert.equal(utcParaLocal("2026-09-04 12:00"), "04/09/2026 09:00");
  });

  it("today e nowLocal saem no formato esperado e sao coerentes entre si", () => {
    const d = today();
    const n = nowLocal();
    assert.match(d, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(n, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    assert.equal(n.slice(0, 10), d);
  });

  it("nao usa o fuso do processo", () => {
    // com TZ=UTC, o metodo ingenuo daria a data UTC; a nossa precisa diferir
    // dela sempre que o instante estiver entre 00:00 e 03:00 UTC
    const instante = new Date("2026-09-05T00:30:00Z");
    assert.notEqual(toISODate(instante), instante.toISOString().slice(0, 10));
    assert.equal(toISODate(instante), "2026-09-04");
  });
});

/**
 * Datas de agenda ("o evento e dia 10/10") sao datas de calendario, nao
 * instantes. A aritmetica montava a data no fuso do servidor e formatava no
 * fuso do negocio, somando a diferenca entre os dois e deslocando um dia:
 * addDays(hoje, 0) devolvia ontem, e a tela de operacao filtrava
 * BETWEEN hoje AND ontem, sem trazer nada.
 */
describe("aritmetica de datas de calendario", () => {
  it("somar zero dias devolve o mesmo dia", () => {
    for (const d of ["2026-09-05", "2026-01-01", "2026-12-31", "2028-02-29"]) {
      assert.equal(addDays(d, 0), d);
    }
  });

  it("o filtro de um unico dia nao fica invertido", () => {
    const d = "2026-09-05";
    assert.ok(addDays(d, 0) >= d, "o fim do periodo nao pode ser antes do inicio");
  });

  it("soma e subtrai atravessando mes e ano", () => {
    assert.equal(addDays("2026-09-30", 1), "2026-10-01");
    assert.equal(addDays("2026-12-31", 1), "2027-01-01");
    assert.equal(addDays("2026-01-01", -1), "2025-12-31");
  });

  it("fim de mes cobre o ultimo dia, inclusive em ano bissexto", () => {
    assert.equal(endOfMonth("2026-09-05"), "2026-09-30");
    assert.equal(endOfMonth("2026-02-10"), "2026-02-28");
    assert.equal(endOfMonth("2028-02-10"), "2028-02-29");
  });

  it("semana comeca na segunda-feira", () => {
    assert.equal(startOfWeek("2026-09-05"), "2026-08-31"); // sabado
    assert.equal(startOfWeek("2026-08-31"), "2026-08-31"); // a propria segunda
  });

  it("nao desloca a data exibida", () => {
    assert.equal(dateBR("2026-09-05"), "05/09/2026");
    assert.equal(dateBR("2026-01-01"), "01/01/2026");
  });
});

describe("leitura de valor digitado", () => {
  it("aceita os formatos que a pessoa realmente digita", () => {
    for (const bom of ["1234", "1234,56", "1.234,56", "R$ 1.234,56", "0,50", "1234.56"]) {
      assert.ok(valorValido(bom), bom);
    }
  });

  it("recusa o que nao da para ler, em vez de virar zero calado", () => {
    for (const ruim of ["", "   ", "abc", "R$", ",", "--"]) {
      assert.equal(valorValido(ruim), false, JSON.stringify(ruim));
    }
  });

  it("milhar com ponto e sem centavos nao pode passar como valido", () => {
    // "1.234.567" vira NaN no parseMoney: antes isso descartava o lancamento
    // em silencio, agora e recusado com mensagem
    assert.equal(valorValido("1.234.567"), false);
    assert.equal(parseMoney("1.234.567"), 0, "confirma que viraria zero");
  });

  it("zero e valido como texto, mas continua sendo zero", () => {
    assert.ok(valorValido("0"));
    assert.equal(parseMoney("0"), 0);
  });
});

describe("carimbo do banco exibido em Brasilia", () => {
  it("converte a hora gravada em UTC para Brasilia", () => {
    // o banco grava 2026-09-07 18:24 (UTC); em Brasilia sao 15:24
    assert.equal(utcParaLocal("2026-09-07 18:24:25"), "07/09/2026 15:24");
  });

  it("a data vira o dia certo quando o carimbo passa da meia-noite em UTC", () => {
    // 01:30 UTC de dia 8 e 22:30 de dia 7 em Brasilia
    assert.equal(dateUtcBR("2026-09-08 01:30:00"), "07/09/2026", "nao pode exibir o dia seguinte");
    assert.equal(dateBR("2026-09-08 01:30:00"), "08/09/2026", "dateBR nao converte, por isso erra aqui");
  });

  it("mesmo dia quando o horario nao cruza a meia-noite", () => {
    assert.equal(dateUtcBR("2026-09-07 18:24:25"), "07/09/2026");
  });

  it("vazio continua vazio", () => {
    assert.equal(dateUtcBR(null), "-");
    assert.equal(dateUtcBR(""), "-");
  });
});
