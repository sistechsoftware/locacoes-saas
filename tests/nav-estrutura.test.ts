/**
 * Estrutura do menu de navegacao.
 *
 * A barra inferior do celular tem um invariante visual (4 itens + botao "Mais"
 * em uma unica linha, grid-cols-5 no Shell) e combinacoes de itens acordadas
 * com a operacao: Agenda direto na barra, Mensagens fora dela (acesso pelo
 * botao flutuante +, sino do topo e "Mais"). Estes testes travam isso.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EXTRA_NAV, MOBILE_NAV, NAV } from "../src/lib/nav";

describe("estrutura do menu", () => {
  it("barra inferior tem exatamente 4 itens diretos (5o espaco e o Mais)", () => {
    assert.equal(MOBILE_NAV.length, 4);
  });

  it("itens da barra inferior sao os acordados com a operacao", () => {
    assert.deepEqual(
      MOBILE_NAV.map((n) => n.href),
      ["/dashboard", "/agenda", "/reservas", "/operacao"],
    );
  });

  it("Mensagens fica fora da barra inferior, mas continua no menu lateral", () => {
    assert.equal(MOBILE_NAV.some((n) => n.href === "/chat"), false);
    const chat = NAV.find((n) => n.href === "/chat");
    assert.ok(chat, "Mensagens precisa continuar no menu lateral (desktop)");
  });

  it("menu Mais contem tudo que nao esta na barra, sem duplicar entradas", () => {
    assert.equal(EXTRA_NAV.some((n) => n.href === "/chat"), true);
    const hrefs = EXTRA_NAV.map((n) => n.href);
    assert.equal(new Set(hrefs).size, hrefs.length, "hrefs duplicados no EXTRA_NAV");
    for (const n of MOBILE_NAV) {
      assert.equal(hrefs.includes(n.href), false, `${n.href} nao pode aparecer na barra e no Mais`);
    }
  });
});
