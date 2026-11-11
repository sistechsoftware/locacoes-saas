import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMoney } from "../src/lib/format.ts";
import { MAX_DIGITOS_MOEDA, centavosDoTexto, textoMoeda, valorParaCampo } from "../src/lib/money-input.ts";

/**
 * Simula a digitação no campo: cada tecla entra pela direita do texto já
 * formatado, exatamente como o onChange do MoneyInput lê o valor.
 */
function digitar(teclas: string, permitirNegativo = false) {
  let texto = "";
  for (const tecla of teclas) {
    texto = textoMoeda(centavosDoTexto(texto + tecla, { permitirNegativo }));
  }
  return { texto, cents: centavosDoTexto(texto, { permitirNegativo }) };
}

/** Simula Backspace: remove o último caractere do texto exibido. */
function apagar(texto: string) {
  const proximo = texto.slice(0, -1);
  return { texto: textoMoeda(centavosDoTexto(proximo)), cents: centavosDoTexto(proximo) };
}

test("digitação sequencial vira centavos e formata a cada tecla", () => {
  const casos: [string, string, number][] = [
    ["1", "R$ 0,01", 1],
    ["10", "R$ 0,10", 10],
    ["100", "R$ 1,00", 100],
    ["1000", "R$ 10,00", 1000],
    ["10000", "R$ 100,00", 10000],
    ["100000", "R$ 1.000,00", 100000],
    ["1000000", "R$ 10.000,00", 1000000],
  ];
  for (const [teclas, texto, cents] of casos) {
    const r = digitar(teclas);
    assert.equal(r.texto, texto, `texto de ${teclas}`);
    assert.equal(r.cents, cents, `centavos de ${teclas}`);
  }
});

test("valores decimais digitados não perdem precisão", () => {
  assert.deepEqual(digitar("150000"), { texto: "R$ 1.500,00", cents: 150000 });
  assert.deepEqual(digitar("123456"), { texto: "R$ 1.234,56", cents: 123456 });
  assert.deepEqual(digitar("9999999999999"), { texto: "R$ 99.999.999.999,99", cents: 9999999999999 });
});

test("apagar com Backspace reduz uma casa por vez e limpa o campo por completo", () => {
  let { texto } = digitar("123456");
  for (const esperado of ["R$ 123,45", "R$ 12,34", "R$ 1,23", "R$ 0,12", "R$ 0,01"]) {
    const r = apagar(texto);
    texto = r.texto;
    assert.equal(texto, esperado);
  }
  const vazio = apagar(texto);
  assert.equal(vazio.cents, null);
  assert.equal(vazio.texto, "");
});

test("campo iniciado em zero aceita digitação imediata", () => {
  assert.deepEqual(digitar("5"), { texto: "R$ 0,05", cents: 5 });
  assert.equal(textoMoeda(centavosDoTexto("R$ 0,005")), "R$ 0,05");
});

test("selecionar tudo e substituir troca o valor inteiro", () => {
  assert.deepEqual(digitar("7"), { texto: "R$ 0,07", cents: 7 });
  assert.deepEqual(digitar("150000"), { texto: "R$ 1.500,00", cents: 150000 });
});

test("colar valor formatado ou decimal mantém o mesmo valor", () => {
  assert.equal(centavosDoTexto("R$ 1.234,56"), 123456);
  assert.equal(centavosDoTexto("1.234,56"), 123456);
  assert.equal(centavosDoTexto("1234.56"), 123456);
  assert.equal(centavosDoTexto("50,00"), 5000);
  assert.equal(centavosDoTexto("  "), null);
  assert.equal(centavosDoTexto("abc"), null);
});

test("negativos só aparecem quando o campo permite", () => {
  assert.equal(centavosDoTexto("-150,00", { permitirNegativo: true }), -15000);
  assert.equal(centavosDoTexto("-150,00"), 15000);
  assert.equal(textoMoeda(-15000), "-R$ 150,00");
});

test("máscara e valor enviado ao backend continuam compatíveis", () => {
  assert.equal(textoMoeda(150000), "R$ 1.500,00");
  assert.equal(valorParaCampo(150000), "1500.00");
  assert.equal(valorParaCampo(null), "");
  assert.equal(valorParaCampo(0), "0.00");
  assert.equal(parseMoney(valorParaCampo(150000)), 150000);
  assert.equal(parseMoney(textoMoeda(-15000)), -15000);
  assert.equal(parseMoney(textoMoeda(123456)), 123456);
});

test("zero digitado não deixa lixo no campo e segue editável", () => {
  assert.equal(textoMoeda(0), "R$ 0,00");
  assert.equal(centavosDoTexto("R$ 0,00"), null);
  assert.equal(digitar("0").cents, null);
  assert.equal(digitar("05").cents, 5);
});

test("limite de dígitos evita valores fora da faixa segura", () => {
  assert.equal(centavosDoTexto("9".repeat(MAX_DIGITOS_MOEDA + 5)), 9999999999999);
  assert.equal(MAX_DIGITOS_MOEDA, 13);
});
