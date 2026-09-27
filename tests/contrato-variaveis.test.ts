/**
 * Substituicao de variaveis do contrato.
 *
 * Campo sem cadastro vira linha para preencher a mao no documento impresso,
 * em vez de sair em branco. O modelo salvo em configuracoes nao muda.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderTemplate } from "../src/lib/settings.ts";

const linha = (n: number) => "_".repeat(n);
const comLinha = (modelo: string, vars: Record<string, any>) =>
  renderTemplate(modelo, vars, { vazio: "linha" });

describe("campo preenchido", () => {
  it("Teste 1 - CPF cadastrado aparece normalmente", () => {
    assert.equal(comLinha("CPF: {{cliente_doc}}", { cliente_doc: "123.456.789-00" }), "CPF: 123.456.789-00");
  });

  it("CNPJ cadastrado aparece normalmente", () => {
    assert.equal(comLinha("CNPJ: {{cnpj}}", { cnpj: "12.345.678/0001-90" }), "CNPJ: 12.345.678/0001-90");
  });

  it("numero zero e um valor valido, nao um vazio", () => {
    assert.equal(comLinha("Numero: {{cliente_numero}}", { cliente_numero: 0 }), "Numero: 0");
  });
});

describe("campo vazio vira linha", () => {
  it("Teste 2 - sem CPF", () => {
    assert.equal(comLinha("CPF: {{cliente_doc}}", { cliente_doc: "" }), `CPF: ${linha(32)}`);
  });

  it("Teste 3 - CPF e CNPJ vazios ganham linha cada um", () => {
    const saida = comLinha("CPF: {{cliente_doc}} CNPJ: {{cnpj}}", { cliente_doc: "", cnpj: "" });
    assert.equal(saida, `CPF: ${linha(32)} CNPJ: ${linha(32)}`);
  });

  it("Teste 5 - valor null", () => {
    assert.equal(comLinha("CPF: {{cliente_doc}}", { cliente_doc: null }), `CPF: ${linha(32)}`);
  });

  it("Teste 6 - string vazia", () => {
    assert.equal(comLinha("CPF: {{cliente_doc}}", { cliente_doc: "" }), `CPF: ${linha(32)}`);
  });

  it("Teste 7 - apenas espacos", () => {
    assert.equal(comLinha("CPF: {{cliente_doc}}", { cliente_doc: "   " }), `CPF: ${linha(32)}`);
  });

  it("variavel ausente do objeto", () => {
    assert.equal(comLinha("CPF: {{cliente_doc}}", {}), `CPF: ${linha(32)}`);
  });
});

describe("Teste 4 - cada variavel e tratada individualmente", () => {
  it("mistura preenchidos e vazios na mesma frase", () => {
    const modelo =
      "CONTRATANTE: {{cliente}}, CPF: {{cliente_doc}}, residente a {{cliente_endereco}}, telefone {{cliente_telefone}}.";
    const saida = comLinha(modelo, {
      cliente: "Joao da Silva",
      cliente_doc: "",
      cliente_endereco: "Rua das Flores, 100",
      cliente_telefone: "(34) 99999-9999",
    });
    assert.equal(
      saida,
      `CONTRATANTE: Joao da Silva, CPF: ${linha(32)}, residente a Rua das Flores, 100, telefone (34) 99999-9999.`,
    );
  });
});

describe("larguras proporcionais ao campo", () => {
  it("telefone e mais curto que endereco", () => {
    const tel = comLinha("{{cliente_telefone}}", {}).length;
    const end = comLinha("{{cliente_endereco}}", {}).length;
    assert.ok(tel < end, `telefone ${tel} deveria ser menor que endereco ${end}`);
  });

  it("cada tipo tem espaco confortavel para escrever", () => {
    assert.ok(comLinha("{{cliente_doc}}", {}).length >= 20, "CPF precisa caber a mao");
    assert.ok(comLinha("{{cliente_endereco}}", {}).length >= 40, "endereco precisa caber a mao");
  });
});

describe("o que nao pode mudar", () => {
  it("variavel calculada nao vira linha, mesmo vazia", () => {
    // itens e totais sao sempre calculados: uma linha ali seria um defeito
    assert.equal(comLinha("Itens: {{itens}}", { itens: "" }), "Itens: ");
    assert.equal(comLinha("Total: {{valor_total}}", { valor_total: "" }), "Total: ");
  });

  it("variavel desconhecida mantem o comportamento antigo", () => {
    assert.equal(comLinha("X: {{nao_existe}}", {}), "X: ");
  });

  it("sem a estrategia, o comportamento e o de antes", () => {
    assert.equal(renderTemplate("CPF: {{cliente_doc}}", { cliente_doc: "" }), "CPF: ");
    assert.equal(renderTemplate("CPF: {{cliente_doc}}", { cliente_doc: "123" }), "CPF: 123");
  });

  it("mensagem de WhatsApp nao ganha underscores", () => {
    // usa o mesmo renderizador, mas sem a estrategia de linha
    const msg = renderTemplate("Ola, {{cliente}}! Saldo de {{saldo}}.", { cliente: "Ana", saldo: "" });
    assert.equal(msg, "Ola, Ana! Saldo de .");
    assert.ok(!msg.includes("_"));
  });

  it("o modelo salvo nao e alterado pela renderizacao", () => {
    const modelo = "CPF: {{cliente_doc}}";
    comLinha(modelo, { cliente_doc: "" });
    assert.equal(modelo, "CPF: {{cliente_doc}}");
  });
});
