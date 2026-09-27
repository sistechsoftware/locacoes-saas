/** Regra dos aniversarios (funcoes puras): data, idade, janela e virada de ano. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  aniversarioNoAno,
  chaveAviso,
  diaMes,
  diasAte,
  diasDoMes,
  fazAniversarioHoje,
  idade,
  idadeQueCompleta,
  janela,
  listar,
  partes,
  primeiroNome,
  textoAviso,
  valida,
} from "../src/lib/aniversarios.ts";

describe("leitura da data", () => {
  it("aceita data pura e data com hora junto", () => {
    assert.deepEqual(partes("1990-09-15"), { ano: 1990, mes: 9, dia: 15 });
    assert.deepEqual(partes("1990-09-15T00:00"), { ano: 1990, mes: 9, dia: 15 });
  });

  it("recusa data que nao existe no calendario", () => {
    assert.equal(partes("2026-02-30"), null);
    assert.equal(partes("2026-13-01"), null);
    assert.equal(partes("2026-04-31"), null);
    assert.equal(valida("2025-02-29"), false, "2025 nao e bissexto");
    assert.equal(valida("2024-02-29"), true, "2024 e bissexto");
  });

  it("cliente sem data nao quebra nada", () => {
    for (const vazio of [null, undefined, "", "  ", "abc"]) {
      assert.equal(partes(vazio as any), null);
      assert.equal(diaMes(vazio as any), null);
      assert.equal(diasAte(String(vazio), "2026-09-07"), null);
      assert.equal(idade(String(vazio), "2026-09-07"), null);
    }
  });

  it("extrai o dia e mes usado na consulta", () => {
    assert.equal(diaMes("1990-09-15"), "09-15");
    assert.equal(diaMes("1985-01-02"), "01-02");
  });
});

describe("quantos dias faltam", () => {
  it("aniversario hoje da zero", () => {
    assert.equal(diasAte("1990-09-07", "2026-09-07"), 0);
    assert.ok(fazAniversarioHoje("1990-09-07", "2026-09-07"));
  });

  it("amanha e daqui a sete dias", () => {
    assert.equal(diasAte("1990-09-08", "2026-09-07"), 1);
    assert.equal(diasAte("1990-09-14", "2026-09-07"), 7);
  });

  it("aniversario que ja passou este ano vai para o ano que vem", () => {
    assert.equal(diasAte("1990-09-06", "2026-09-07"), 364, "2027 nao e bissexto");
  });

  it("vira o ano corretamente", () => {
    // hoje 29/12: 30/12, 31/12, 01/01 e 02/01 sao proximos, nao passados
    assert.equal(diasAte("1990-12-30", "2026-12-29"), 1);
    assert.equal(diasAte("1990-12-31", "2026-12-29"), 2);
    assert.equal(diasAte("1990-01-01", "2026-12-29"), 3);
    assert.equal(diasAte("1990-01-02", "2026-12-29"), 4);
  });

  it("fim de mes funciona", () => {
    assert.equal(diasAte("1990-09-30", "2026-09-28"), 2);
    assert.equal(diasAte("1990-10-01", "2026-09-30"), 1);
  });

  it("nascido em 29/02 comemora em 28/02 nos anos comuns", () => {
    assert.equal(aniversarioNoAno("2000-02-29", 2027), "2027-02-28");
    assert.equal(aniversarioNoAno("2000-02-29", 2028), "2028-02-29", "2028 e bissexto");
    assert.ok(fazAniversarioHoje("2000-02-29", "2027-02-28"), "nao pode ficar sem aniversario");
  });
});

describe("idade", () => {
  it("conta certo depois do aniversario", () => {
    assert.equal(idade("1990-09-15", "2026-09-20"), 36);
  });

  it("nao conta o ano antes do aniversario", () => {
    assert.equal(idade("1990-09-15", "2026-09-14"), 35, "faltando um dia ainda tem 35");
    assert.equal(idade("1990-12-25", "2026-09-07"), 35, "dezembro ainda nao chegou");
  });

  it("no proprio aniversario ja conta", () => {
    assert.equal(idade("1990-09-15", "2026-09-15"), 36);
  });

  it("a idade que completa e a proxima, exceto no proprio dia", () => {
    assert.equal(idadeQueCompleta("1990-09-15", "2026-09-15"), 36, "hoje completa 36");
    assert.equal(idadeQueCompleta("1990-09-15", "2026-09-14"), 36, "amanha completa 36");
    assert.equal(idadeQueCompleta("1990-09-15", "2026-09-16"), 37, "so ano que vem");
  });

  it("recusa idade absurda em vez de exibir numero errado", () => {
    assert.equal(idade("1700-01-01", "2026-09-07"), null);
    assert.equal(idade("2030-01-01", "2026-09-07"), null, "data no futuro");
  });
});

describe("janela de dias", () => {
  it("hoje mais sete dias da oito datas", () => {
    const j = janela("2026-09-07", 7);
    assert.equal(j.length, 8);
    assert.equal(j[0], "09-07");
    assert.equal(j.at(-1), "09-14");
  });

  it("so hoje quando a antecedencia e zero", () => {
    assert.deepEqual(janela("2026-09-07", 0), ["09-07"]);
  });

  it("atravessa a virada do ano", () => {
    const j = janela("2026-12-29", 7);
    assert.ok(j.includes("12-31"));
    assert.ok(j.includes("01-01"), "primeiro de janeiro entra");
    assert.ok(j.includes("01-05"));
  });

  it("cobre quem nasceu em 29/02 quando o ano nao e bissexto", () => {
    const j = janela("2027-02-26", 3);
    assert.ok(j.includes("02-28"));
    assert.ok(j.includes("02-29"), "senao esse cliente sumiria do aviso");
  });

  it("nao repete data quando a janela e maior que o ano", () => {
    const j = janela("2026-09-07", 400);
    assert.equal(new Set(j).size, j.length);
  });

  it("lista os dias de um mes, respeitando fevereiro", () => {
    assert.equal(diasDoMes(2026, 2).length, 28);
    assert.equal(diasDoMes(2024, 2).length, 29);
    assert.equal(diasDoMes(2026, 9).length, 30);
    assert.equal(diasDoMes(2026, 1).length, 31);
  });
});

describe("avisos", () => {
  it("a chave nao deixa repetir aviso no mesmo dia", () => {
    const a = chaveAviso("hoje", 7, "2026-09-07");
    assert.equal(a, chaveAviso("hoje", 7, "2026-09-07T10:00"));
    assert.notEqual(a, chaveAviso("hoje", 7, "2027-09-07"), "ano que vem avisa de novo");
    assert.notEqual(a, chaveAviso("proximo", 7, "2026-09-07"), "tipos diferentes");
    assert.notEqual(a, chaveAviso("hoje", 8, "2026-09-07"), "clientes diferentes");
  });

  it("o texto muda com a quantidade de pessoas", () => {
    assert.match(textoAviso("hoje", ["Joao"]).title, /Aniversariante de hoje/);
    assert.match(textoAviso("hoje", ["Joao", "Maria"]).title, /\(2\)/);
    assert.match(textoAviso("hoje", ["Joao", "Maria"]).body, /Joao e Maria/);
  });

  it("aviso de proximo fala em dias, e amanha e amanha", () => {
    assert.match(textoAviso("proximo", ["Joao"], 1).body, /amanhã/);
    assert.match(textoAviso("proximo", ["Joao"], 3).body, /em 3 dias/);
  });

  it("o aviso nao expoe a data de nascimento", () => {
    const t = textoAviso("hoje", ["Joao Ribeiro"]);
    assert.ok(!/\d{2}\/\d{2}\/\d{4}/.test(t.body), "nada de data completa no aviso");
    assert.ok(!/\d{4}-\d{2}-\d{2}/.test(t.body));
  });

  it("lista nomes de forma legivel", () => {
    assert.equal(listar(["Joao"]), "Joao");
    assert.equal(listar(["Joao", "Maria"]), "Joao e Maria");
    assert.equal(listar(["Joao", "Maria", "Ana"]), "Joao, Maria e Ana");
    assert.equal(listar(["Joao", "Maria", "Ana", "Pedro", "Rita"]), "Joao, Maria e Ana e mais 2");
  });

  it("usa o primeiro nome para falar com o cliente", () => {
    assert.equal(primeiroNome("Joao Ribeiro da Silva"), "Joao");
    assert.equal(primeiroNome("  Maria  "), "Maria");
    assert.equal(primeiroNome(""), "");
  });
});
