/**
 * Saidas do financeiro e o catalogo de finalidades, com o SQL real.
 *
 * O foco e a causa do problema relatado: lancamento que parecia salvo e nao
 * chegava ao banco, e lancamento que chegava mas sumia da tela.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "./helpers/d1.ts";
import { all, insert, one, run, scalar } from "../src/lib/db.ts";
import { parseMoney, valorValido } from "../src/lib/format.ts";

async function cenario() {
  createTestDb();
  await insert(`INSERT INTO users (id, name, username, password_hash, role) VALUES (1,'Op','op','x','admin')`);
}

/** Reproduz o que a acao faz ao gravar, sem depender do Next. */
async function lancarSaida(valorDigitado: string, data = "2026-09-07", finalidade = "Combustivel") {
  if (!valorValido(valorDigitado)) return { erro: "valor ilegivel", id: 0 };
  const amount = parseMoney(valorDigitado);
  if (amount <= 0) return { erro: "valor zero", id: 0 };
  const id = await insert(
    `INSERT INTO expenses (date, category, description, amount_cents, method, status, created_by)
     VALUES (?,?,?,?,'pix','pago',1)`,
    [data, finalidade, "", amount],
  );
  const gravado = await one<any>(`SELECT id FROM expenses WHERE id = ?`, [id]);
  return gravado ? { erro: null, id } : { erro: "nao gravou", id: 0 };
}

describe("valores que o sistema descartava em silencio", () => {
  it("o milhar com ponto virava zero e o lancamento sumia", () => {
    // esta e a causa raiz: parseMoney devolve 0 para NaN, e a acao antiga
    // fazia "if (amount <= 0) return" sem avisar ninguem
    assert.equal(parseMoney("1.234.567"), 0);
    assert.equal(valorValido("1.234.567"), false, "agora e recusado com mensagem");
  });

  it("texto sem numero tambem era descartado calado", () => {
    assert.equal(parseMoney("abc"), 0);
    assert.equal(valorValido("abc"), false);
  });

  it("os formatos normais continuam funcionando", () => {
    assert.equal(parseMoney("50"), 5000);
    assert.equal(parseMoney("50,00"), 5000);
    assert.equal(parseMoney("1.234,56"), 123456);
    assert.equal(parseMoney("R$ 1.234,56"), 123456);
    assert.equal(parseMoney("0,50"), 50);
  });
});

describe("gravacao da saida", () => {
  beforeEach(cenario);

  it("valor inteiro grava e permanece no banco", async () => {
    const r = await lancarSaida("50");
    assert.equal(r.erro, null);
    assert.ok(r.id > 0, "id valido");
    const e = await one<any>(`SELECT * FROM expenses WHERE id = ?`, [r.id]);
    assert.equal(e.amount_cents, 5000);
  });

  it("valor com centavos grava certo", async () => {
    const r = await lancarSaida("1.234,56");
    assert.equal((await one<any>(`SELECT amount_cents FROM expenses WHERE id=?`, [r.id])).amount_cents, 123456);
  });

  it("valor ilegivel nao grava e devolve erro em vez de fingir sucesso", async () => {
    const r = await lancarSaida("1.234.567");
    assert.ok(r.erro, "precisa avisar");
    assert.equal(await scalar<number>(`SELECT COUNT(*) FROM expenses`), 0, "nada foi gravado");
  });

  it("valor zero nao grava e avisa", async () => {
    const r = await lancarSaida("0");
    assert.ok(r.erro);
    assert.equal(await scalar<number>(`SELECT COUNT(*) FROM expenses`), 0);
  });

  it("varios lancamentos seguidos sao todos gravados", async () => {
    for (const v of ["10", "20,50", "1.000,00", "0,99", "5000"]) await lancarSaida(v);
    assert.equal(await scalar<number>(`SELECT COUNT(*) FROM expenses`), 5);
    assert.equal(
      await scalar<number>(`SELECT SUM(amount_cents) FROM expenses`),
      1000 + 2050 + 100000 + 99 + 500000,
    );
  });

  it("datas passadas e futuras gravam igual", async () => {
    await lancarSaida("10", "2025-01-15");
    await lancarSaida("20", "2026-12-31");
    assert.equal(await scalar<number>(`SELECT COUNT(*) FROM expenses`), 2);
  });
});

describe("a saida que some da tela", () => {
  beforeEach(cenario);

  it("lancamento fora do periodo filtrado existe no banco, mas nao aparece na lista", async () => {
    // este era o segundo motivo do "salvei e sumiu": a lista filtra por mes
    await lancarSaida("100", "2025-03-10");
    const noBanco = await scalar<number>(`SELECT COUNT(*) FROM expenses`);
    const naTela = await scalar<number>(
      `SELECT COUNT(*) FROM expenses WHERE date BETWEEN '2026-09-01' AND '2026-09-30'`,
    );
    assert.equal(noBanco, 1, "esta gravado");
    assert.equal(naTela, 0, "mas fora do filtro do mes, por isso a tela precisa avisar");
  });

  it("dentro do periodo aparece normalmente", async () => {
    await lancarSaida("100", "2026-09-07");
    assert.equal(
      await scalar<number>(`SELECT COUNT(*) FROM expenses WHERE date BETWEEN '2026-09-01' AND '2026-09-30'`),
      1,
    );
  });
});

describe("catalogo de finalidades", () => {
  beforeEach(cenario);

  it("as finalidades que ja existiam vieram para a tabela", async () => {
    const nomes = (await all<any>(`SELECT name FROM expense_purposes ORDER BY id`)).map((p) => p.name);
    for (const antiga of ["Combustivel", "Manutencao", "Compra de equipamentos", "Limpeza", "Funcionarios", "Divulgacao", "Outros"]) {
      assert.ok(nomes.includes(antiga), `${antiga} precisa continuar existindo`);
    }
  });

  it("nao aceita duplicata, nem trocando maiuscula por minuscula", async () => {
    await insert(`INSERT INTO expense_purposes (name) VALUES ('Manutencao do veiculo')`);
    await assert.rejects(
      () => insert(`INSERT INTO expense_purposes (name) VALUES ('manutencao do veiculo')`),
      "o banco tem que recusar",
    );
  });

  it("finalidade nova pode ser usada num lancamento", async () => {
    await insert(`INSERT INTO expense_purposes (name, created_by) VALUES ('Manutencao do veiculo', 1)`);
    const r = await lancarSaida("300", "2026-09-07", "Manutencao do veiculo");
    assert.equal(r.erro, null);
    assert.equal((await one<any>(`SELECT category FROM expenses WHERE id=?`, [r.id])).category, "Manutencao do veiculo");
  });

  it("desativar uma finalidade nao encosta nas saidas ja lancadas", async () => {
    for (let i = 0; i < 5; i++) await lancarSaida("100", "2026-09-07", "Combustivel");
    const antes = await all<any>(`SELECT id, category, amount_cents, date FROM expenses ORDER BY id`);

    await run(`UPDATE expense_purposes SET active = 0 WHERE lower(name) = 'combustivel'`);

    const depois = await all<any>(`SELECT id, category, amount_cents, date FROM expenses ORDER BY id`);
    assert.deepEqual(depois, antes, "valores, datas e finalidades intactos");
    assert.equal(depois.length, 5);
  });

  it("renomear a finalidade nao reescreve o historico", async () => {
    await lancarSaida("100", "2026-09-07", "Combustivel");
    await run(`UPDATE expense_purposes SET name = 'Combustivel e pedagio' WHERE lower(name) = 'combustivel'`);
    assert.equal(
      (await one<any>(`SELECT category FROM expenses LIMIT 1`)).category,
      "Combustivel",
      "a saida antiga guarda o texto do dia em que foi lancada",
    );
  });

  it("so as ativas entram na lista de escolha, e a antiga continua legivel", async () => {
    await lancarSaida("100", "2026-09-07", "Combustivel");
    await run(`UPDATE expense_purposes SET active = 0 WHERE lower(name) = 'combustivel'`);
    const ativas = (await all<any>(`SELECT name FROM expense_purposes WHERE active = 1`)).map((p) => p.name);
    assert.ok(!ativas.includes("Combustivel"), "sai das opcoes novas");
    assert.equal((await one<any>(`SELECT category FROM expenses LIMIT 1`)).category, "Combustivel", "mas a saida mostra");
  });

  it("o resumo agrupa pelo que foi lancado, inclusive finalidade nova", async () => {
    await insert(`INSERT INTO expense_purposes (name) VALUES ('Manutencao do veiculo')`);
    await lancarSaida("100", "2026-09-07", "Manutencao do veiculo");
    await lancarSaida("50", "2026-09-07", "Combustivel");
    const resumo = await all<any>(
      `SELECT category, SUM(amount_cents) total FROM expenses GROUP BY category ORDER BY total DESC`,
    );
    assert.equal(resumo.length, 2);
    assert.equal(resumo[0].category, "Manutencao do veiculo", "a finalidade nova aparece no resumo");
  });
});

describe("nao mexeu no resto do financeiro", () => {
  beforeEach(cenario);

  it("entradas continuam sendo gravadas em payments, sem relacao com o catalogo", async () => {
    const id = await insert(
      `INSERT INTO payments (amount_cents, method, paid_at, created_by) VALUES (5000,'pix','2026-09-07',1)`,
    );
    assert.ok(id > 0);
    assert.equal(await scalar<number>(`SELECT COUNT(*) FROM expenses`), 0, "entrada nao vira saida");
  });

  it("expenses.category continua texto livre, sem chave estrangeira travando", async () => {
    // e isso que protege o historico: nenhuma mudanca no catalogo pode
    // invalidar uma linha ja gravada
    const r = await lancarSaida("100", "2026-09-07", "Finalidade que nem esta no catalogo");
    assert.equal(r.erro, null);
  });
});
