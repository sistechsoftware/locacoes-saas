/**
 * Regra do adiantamento (funcoes puras).
 *
 * Situacao vem de situacaoParcela, ja testada em financeiro.test.ts; aqui so
 * confere o mapeamento de rotulo e as validacoes especificas do adiantamento.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mensagemLembreteAntecipado,
  mensagemLembreteHoje,
  situacaoAdiantamento,
  validarDataPrevista,
  validarValorAdiantamento,
} from "../src/lib/adiantamento.ts";

describe("situacao do adiantamento", () => {
  const entry = (extra: Partial<{ amount_cents: number; due_date: string; status: string }> = {}) => ({
    amount_cents: 20000,
    due_date: "2026-10-06",
    status: "aberta",
    ...extra,
  });

  it("nao vencido e sem nada recebido: agendado", () => {
    assert.equal(situacaoAdiantamento(entry(), 0, "2026-09-07"), "agendado");
  });

  it("vencido e nada recebido: atrasado", () => {
    assert.equal(situacaoAdiantamento(entry(), 0, "2026-10-07"), "atrasado");
  });

  it("valor recebido cobre o total: recebido", () => {
    assert.equal(situacaoAdiantamento(entry(), 20000, "2026-09-07"), "recebido");
  });

  it("cancelado nunca aparece como atrasado, mesmo vencido", () => {
    assert.equal(situacaoAdiantamento(entry({ status: "cancelada" }), 0, "2026-10-07"), "cancelado");
  });

  it("recebido parcialmente ainda conta como agendado, nao como recebido", () => {
    assert.equal(situacaoAdiantamento(entry(), 10000, "2026-09-07"), "agendado");
  });
});

describe("validacao do valor", () => {
  it("recusa zero e negativo", () => {
    assert.match(validarValorAdiantamento(0, 50000) ?? "", /maior que zero/);
    assert.match(validarValorAdiantamento(-100, 50000) ?? "", /maior que zero/);
  });

  it("recusa acima do saldo disponivel da reserva", () => {
    const erro = validarValorAdiantamento(60000, 50000);
    assert.match(erro ?? "", /saldo disponível/);
    assert.match(erro ?? "", /500,00/);
  });

  it("aceita exatamente o saldo inteiro", () => {
    assert.equal(validarValorAdiantamento(50000, 50000), null);
  });

  it("aceita um valor abaixo do saldo", () => {
    assert.equal(validarValorAdiantamento(20000, 50000), null);
  });
});

describe("validacao da data", () => {
  it("recusa vazio e formato invalido", () => {
    assert.ok(validarDataPrevista(""));
    assert.ok(validarDataPrevista("06/10/2026"));
  });

  it("aceita ISO valido", () => {
    assert.equal(validarDataPrevista("2026-10-06"), null);
  });
});

describe("mensagens de lembrete", () => {
  it("o lembrete do dia usa exatamente a voz pedida", () => {
    const m = mensagemLembreteHoje("Joao da Silva", 20000);
    assert.match(m.body, /^Opa! Hoje é dia de cobrar o adiantamento do cliente Joao da Silva, no valor de R\$ 200,00\.$/);
  });

  it("o lembrete antecipado fala em dias, e amanha e amanha", () => {
    assert.match(mensagemLembreteAntecipado("Joao", 20000, 3).body, /daqui a 3 dias/);
    assert.match(mensagemLembreteAntecipado("Joao", 20000, 1).body, /amanhã/);
    assert.ok(!mensagemLembreteAntecipado("Joao", 20000, 1).body.includes("daqui a 1 dias"));
  });

  it("nenhum lembrete estoura o valor em reais errado", () => {
    assert.match(mensagemLembreteHoje("Joao", 150).body, /R\$ 1,50/);
    assert.match(mensagemLembreteHoje("Joao", 100000).body, /R\$ 1000,00/);
  });
});
