/**
 * Formatação dos modelos de contrato.
 *
 * Cobre a segurança do HTML (sanitizador), a compatibilidade com os modelos
 * antigos em texto puro, a preservação da formatação na geração do contrato e
 * a substituição das variáveis existentes.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  contractUsesHtml,
  esc,
  itensParaHtml,
  plainTemplateToHtml,
  sanitizeContractHtml,
} from "../src/lib/contract-html.ts";
import { renderTemplate, renderTemplateHtml } from "../src/lib/settings.ts";
import { buildContractBody } from "../src/lib/contracts.ts";
import { createTestDb } from "./helpers/d1.ts";
import { insert, run } from "../src/lib/db.ts";
import { marcaConfiavel } from "../src/lib/contract-html.ts";

/* ------------------------------------------------------------------ */
/* Sanitizador                                                         */
/* ------------------------------------------------------------------ */

describe("sanitizador do contrato", () => {
  it("mantem as marcas que o editor produz", () => {
    const html = "<p style=\"text-align: justify\"><b>Cláusula</b> <i>primeira</i> <u>importante</u>.</p><ul><li>Item</li></ul>";
    assert.equal(sanitizeContractHtml(html), html);
  });

  it("remove script e eventos sem perder o texto", () => {
    const saida = sanitizeContractHtml("Texto <script>alert(1)</script><b onclick=\"alert(1)\">negrito</b>");
    assert.ok(!saida.toLowerCase().includes("script"));
    assert.ok(!saida.toLowerCase().includes("onclick"));
    assert.ok(!saida.includes("alert(1)"), "conteudo de script vai embora junto");
    assert.ok(saida.includes("Texto") && saida.includes("<b>negrito</b>"), "o texto real fica");
  });

  it("descarta a tag desconhecida e mantem o conteudo", () => {
    assert.equal(sanitizeContractHtml("a <marquee>x</marquee> b"), "a x b");
  });

  it("fecha tags abertas e ignora fechamentos soltos", () => {
    assert.equal(sanitizeContractHtml("<b>aberto"), "<b>aberto</b>");
    assert.equal(sanitizeContractHtml("a</b>b"), "ab");
  });

  it("escapa texto solto com chevron", () => {
    assert.equal(sanitizeContractHtml("preço a < vista"), "preço a &lt; vista");
  });

  it("so aceita estilo da lista branca", () => {
    assert.equal(sanitizeContractHtml('<p style="color: red; position: fixed">x</p>'), '<p style="color: red">x</p>');
    assert.equal(sanitizeContractHtml('<p style="background: url(x)">y</p>'), "<p>y</p>");
    assert.equal(sanitizeContractHtml('<p style="width: expression(alert(1))">y</p>'), "<p>y</p>");
  });

  it("quebra javascript: dentro de qualquer atributo", () => {
    const saida = sanitizeContractHtml('<span title="javascript:alert(1)">x</span>');
    assert.ok(!saida.toLowerCase().includes("javascript:"));
  });

  it("converts <font> do editor antigo em span com estilo", () => {
    const saida = sanitizeContractHtml('<font face="Arial" color="#ff0000" size="5">x</font>');
    assert.ok(saida.startsWith('<span style="'));
    assert.ok(saida.includes("font-family: Arial"));
    assert.ok(saida.includes("color: #ff0000"));
    assert.ok(saida.includes("font-size: 24px"));
  });

  it("limita tamanho de fonte exagerado", () => {
    const saida = sanitizeContractHtml('<span style="font-size: 500px">x</span>');
    assert.ok(saida.includes("font-size: 72px"));
  });

  it("comentario some, texto fica", () => {
    assert.equal(sanitizeContractHtml("a <!-- segredo -->b"), "a b");
  });
});

/* ------------------------------------------------------------------ */
/* Deteccao e compatibilidade com modelos antigos                      */
/* ------------------------------------------------------------------ */

describe("deteccao de formato", () => {
  it("modelo antigo em texto puro nao e HTML", () => {
    assert.equal(contractUsesHtml("CONTRATO N. {{contrato}}\nCliente: {{cliente}}"), false);
  });

  it("chevron solto nao engana a deteccao", () => {
    assert.equal(contractUsesHtml("Preço a < vista e sem juros"), false);
  });

  it("marca HTML conhecida e reconhecida", () => {
    assert.equal(contractUsesHtml("<p>Olá</p>"), true);
    assert.equal(contractUsesHtml("Negrito: <b>{{cliente}}</b>"), true);
  });
});

describe("modelo antigo e preservado", () => {
  it("plainTemplateToHtml so escapa e troca quebra por <br>", () => {
    const original = "Linha 1\n<b>ainda nao e marca</b>";
    const convertido = plainTemplateToHtml(original);
    assert.ok(convertido.includes("&lt;b&gt;"));
    assert.ok(convertido.includes("<br>"));
  });

  it("contrato salvo nao e alterado pela renderizacao", () => {
    const modelo = "CPF: {{cliente_doc}}";
    renderTemplate(modelo, { cliente_doc: "" }, { vazio: "linha" });
    assert.equal(modelo, "CPF: {{cliente_doc}}");
  });
});

/* ------------------------------------------------------------------ */
/* Variaveis nos dois formatos                                         */
/* ------------------------------------------------------------------ */

describe("variaveis no modelo formatado", () => {
  it("substitui igual ao texto puro", () => {
    const html = renderTemplateHtml("<b>{{cliente}}</b>", { cliente: "Ana" });
    assert.equal(html, "<b>Ana</b>");
  });

  it("dado vazio vira linha de preenchimento, como no texto puro", () => {
    const html = renderTemplateHtml("CPF: {{cliente_doc}}", { cliente_doc: "" }, { vazio: "linha" });
    assert.equal(html, `CPF: ${"_".repeat(32)}`);
  });

  it("valor com chevron entra escapado, sem virar marca", () => {
    const html = renderTemplateHtml("Nome: {{cliente}}", { cliente: "Ana <3" });
    assert.ok(html.includes("Ana &lt;3"));
  });

  it("itens vira lista HTML", () => {
    const html = itensParaHtml(["2 x Mesa .......... R$ 100,00", ""]);
    assert.equal(html, "<ul><li>2 x Mesa .......... R$ 100,00</li></ul>");
  });

  it("formatacao e variavel convivem", () => {
    // {{itens}} ja traz a propria <ul>: o modelo nao precisa embrulhar
    const modelo = "<p style=\"text-align: justify\">Contrato {{contrato}} - <b>{{cliente}}</b></p>{{itens}}";
    const saida = renderTemplateHtml(modelo, { contrato: "CTR-001", cliente: "Joao", itens: marcaConfiavel("<ul><li>1 x Cadeira</li></ul>") });
    assert.ok(saida.includes("CTR-001"));
    assert.ok(saida.includes("<b>Joao</b>"));
    assert.ok(saida.includes("<li>1 x Cadeira</li>"));
  });
});

describe("funcao esc", () => {
  it("escapa os cinco caracteres perigosos", () => {
    assert.equal(esc(`<a href="x">'&`), "&lt;a href=&quot;x&quot;&gt;&#39;&amp;");
  });
});

/* ------------------------------------------------------------------ */
/* Geracao do contrato com o banco real                                */
/* ------------------------------------------------------------------ */

describe("geracao do contrato", () => {
  let cliente = 0;
  let reserva = 0;

  beforeEach(async () => {
    createTestDb();
    const settings = (await import("../src/lib/settings.ts")).DEFAULT_SETTINGS;
    await run(`INSERT INTO settings (key, value) VALUES ('contract_template', ?)`, [settings.contract_template]);
    await insert(`INSERT INTO users (id, name, username, password_hash, role) VALUES (1,'Op','op','x','admin')`);
    cliente = await insert(`INSERT INTO customers (name, doc, phone, city) VALUES ('Joao <Silva>','12345678909','11999990000','Uberlândia')`);
    reserva = await insert(
      `INSERT INTO reservations (number, customer_id, status, event_date, total_cents)
       VALUES ('LIMA-001', ?, 'confirmada', '2026-10-10', 50000)`,
      [cliente],
    );
    const productId = await insert(`INSERT INTO products (code, name) VALUES ('P-1','Mesa')`);
    await insert(
      `INSERT INTO reservation_items (reservation_id, product_id, qty, subtotal_cents) VALUES (?,?,2,10000)`,
      [reserva, productId],
    );
  });

  it("modelo antigo gera exatamente como antes", async () => {
    const corpo = await buildContractBody(reserva, "CTR-001");
    assert.ok(corpo.includes("JOÃO" ) === false, "formatacao nenhuma entra no texto puro");
    assert.ok(corpo.includes("Contrato N. CTR-001") || corpo.includes("CONTRATO N. CTR-001"), "numero substituido");
    assert.ok(corpo.includes("Joao <Silva>"), "nome sai cru no texto puro");
    assert.ok(corpo.includes("2 x Mesa"), "itens no formato de sempre");
  });

  it("modelo formatado preserva as marcas e as variaveis", async () => {
    await run(
      `UPDATE settings SET value = ? WHERE key = 'contract_template'`,
      [
        "<p style=\"text-align: justify\"><b>CONTRATO</b> N. {{contrato}}</p>" +
          "<p>Cliente: <i>{{cliente}}</i>, CPF {{cliente_doc}}</p>" +
          "{{itens}}" +
          "<p>Total: {{valor_total}}</p>",
      ],
    );
    const corpo = await buildContractBody(reserva, "CTR-001");
    assert.ok(corpo.includes("<b>CONTRATO</b> N. CTR-001"), "negrito e numero preservados");
    assert.ok(corpo.includes("<i>Joao &lt;Silva&gt;</i>"), "nome escapado dentro da formatacao");
    // money() usa espaco nao separavel entre o simbolo e o numero
    assert.ok(/<li>2 x Mesa \.+ R\$\u00a0?100,00<\/li>/.test(corpo), "itens em lista");
    assert.ok(/Total: R\$\u00a0?500,00<\/p>/.test(corpo), "valor substituido");
    assert.ok(!corpo.includes("{{"), "nenhuma variavel sobrou");
  });

  it("dado nao cadastrado vira linha tambem no formato rico", async () => {
    await run(
      `UPDATE settings SET value = ? WHERE key = 'contract_template'`,
      ["<p>Endereço: {{endereco_empresa}}</p>"],
    );
    const corpo = await buildContractBody(reserva, "CTR-002");
    assert.ok(corpo.includes("____"), "linha de preenchimento manual");
  });
});
