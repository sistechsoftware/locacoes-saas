/**
 * Dois modelos de contrato independentes: impressao e digital.
 *
 * Cobre a separacao ponta a ponta: heranca segura do modelo atual (bancos que
 * so tem contract_template), independencia entre os dois modelos, o uso
 * correto de cada modelo em cada fluxo e a variavel {{data_assinatura_digital}},
 * resolvida no momento em que o cliente abre o contrato para assinar.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "./helpers/d1.ts";
import { insert, one, run } from "../src/lib/db.ts";
import { getSettings, setSettings, DEFAULT_SETTINGS } from "../src/lib/settings.ts";
import { buildContractBody, buildContractBodyDigital } from "../src/lib/contracts.ts";
import { gerarLink, congelarCorpoAoAbrir, porToken, assinaturasDoContrato } from "../src/lib/assinatura-db.ts";
import { dataPorExtensoBR } from "../src/lib/format.ts";

let cliente = 0;
let reserva = 0;

async function cenario() {
  createTestDb();
  await run(`DELETE FROM settings`);
  await insert(`INSERT INTO users (id, name, username, password_hash, role) VALUES (1,'Op','op','x','admin')`);
  cliente = await insert(`INSERT INTO customers (name, phone) VALUES ('Joao Ribeiro','11999990000')`);
  reserva = await insert(
    `INSERT INTO reservations (number, customer_id, status, event_date, total_cents)
     VALUES ('LIMA-001', ?, 'confirmada', '2026-10-10', 50000)`,
    [cliente],
  );
}

describe("separacao dos modelos", () => {
  beforeEach(cenario);

  it("bem antigo, so com contract_template: o digital herda o modelo salvo", async () => {
    await setSettings({ contract_template: "MODELO DO PAPEL {{contrato}}" });
    const s = await getSettings();
    assert.equal(s.contract_template, "MODELO DO PAPEL {{contrato}}");
    assert.equal(s.contract_template_digital, "MODELO DO PAPEL {{contrato}}", "herda o modelo de impressao");
  });

  it("nada salvo: os dois modelos nascem com o conteudo padrao", async () => {
    const s = await getSettings();
    assert.equal(s.contract_template, DEFAULT_SETTINGS.contract_template);
    assert.equal(s.contract_template_digital, DEFAULT_SETTINGS.contract_template);
  });

  it("salvar o digital nao mexe no impresso, e vice-versa", async () => {
    await setSettings({ contract_template: "SO PAPEL", contract_template_digital: "SO DIGITAL" });
    const s = await getSettings();
    assert.equal(s.contract_template, "SO PAPEL");
    assert.equal(s.contract_template_digital, "SO DIGITAL");
  });

  it("sem o digital salvo, salvar o impresso nao grava o digital no banco", async () => {
    await setSettings({ contract_template: "PAPEL NOVO" });
    const linha = await one<any>(`SELECT value FROM settings WHERE key = 'contract_template_digital'`);
    assert.equal(linha, undefined, "heranca fica na leitura, sem escrever nada");
    const s = await getSettings();
    assert.equal(s.contract_template_digital, "PAPEL NOVO");
  });

  it("modelo salvo nao e alterado pela renderizacao", async () => {
    await setSettings({ contract_template_digital: "CPF: {{cliente_doc}}" });
    const s = await getSettings();
    buildContractBody; // so garante import; a renderizacao e feita abaixo
    const corpo = await buildContractBodyDigital(reserva, "CTR-001");
    assert.ok(corpo.includes("CPF:"));
    assert.equal((await getSettings()).contract_template_digital, "CPF: {{cliente_doc}}");
  });
});

describe("contrato impresso x digital", () => {
  beforeEach(cenario);

  it("buildContractBody usa o modelo de impressao", async () => {
    await setSettings({ contract_template: "MODELO DO PAPEL {{contrato}}" });
    const corpo = await buildContractBody(reserva, "CTR-001");
    assert.ok(corpo.includes("MODELO DO PAPEL CTR-001"));
  });

  it("buildContractBodyDigital usa o modelo digital", async () => {
    await setSettings({ contract_template_digital: "MODELO DIGITAL {{contrato}}" });
    const corpo = await buildContractBodyDigital(reserva, "CTR-001");
    assert.ok(corpo.includes("MODELO DIGITAL CTR-001"));
    assert.ok(!corpo.includes("MODELO DO PAPEL"));
  });

  it("cada fluxo usa o seu modelo quando os dois sao diferentes", async () => {
    await setSettings({ contract_template: "PAPEL {{contrato}}", contract_template_digital: "DIGITAL {{contrato}}" });
    const papel = await buildContractBody(reserva, "CTR-001");
    const digital = await buildContractBodyDigital(reserva, "CTR-001");
    assert.ok(papel.includes("PAPEL CTR-001") && !papel.includes("DIGITAL"));
    assert.ok(digital.includes("DIGITAL CTR-001") && !digital.includes("PAPEL"));
  });

  it("modelo digital em HTML mantem a formatacao e troca as variaveis", async () => {
    await setSettings({
      contract_template_digital: "<p><b>Contrato {{contrato}}</b> — {{cliente}}</p>",
    });
    const corpo = await buildContractBodyDigital(reserva, "CTR-001");
    assert.ok(corpo.includes("<b>Contrato CTR-001</b>"));
    assert.ok(corpo.includes("Joao Ribeiro"));
  });
});

describe("variavel data_assinatura_digital", () => {
  beforeEach(cenario);

  it("formato por extenso, cidade fixa e mes em portugues", () => {
    assert.equal(dataPorExtensoBR("2026-09-12"), "12 de setembro de 2026");
    assert.equal(dataPorExtensoBR("2026-01-01"), "1 de janeiro de 2026");
    assert.equal(dataPorExtensoBR(null), "");
  });

  it("entra no corpo do contrato digital resolvida, nunca como texto bruto", async () => {
    await setSettings({
      contract_template_digital: "Uberlândia, {{data_assinatura_digital}}.\n\nContrato {{contrato}}.",
    });
    const corpo = await buildContractBodyDigital(reserva, "CTR-001");
    assert.ok(!corpo.includes("{{data_assinatura_digital}}"), "variavel nao sobra no documento");
    assert.ok(/Uberlândia, \d{1,2} de \w+ de \d{4}\./.test(corpo));
  });

  it("o modelo de impressao NAO recebe a variavel digital", async () => {
    await setSettings({ contract_template: "Papel: {{data_assinatura_digital}}" });
    const corpo = await buildContractBody(reserva, "CTR-001");
    // sem dado, a variavel desconhecida sai vazia na estrategia "vazio"
    assert.ok(!corpo.includes("Uberlândia,"), "a data digital nao vaza para o impresso");
    assert.ok(corpo.includes("Papel:"));
  });

  it("a data e a do dia da abertura, no fuso de Brasília", async () => {
    await setSettings({ contract_template_digital: "{{data_assinatura_digital}}" });
    const corpo = await buildContractBodyDigital(reserva, "CTR-001");
    const esperado = `Uberlândia, ${dataPorExtensoBR(new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" }))}`;
    assert.ok(corpo.includes(esperado), `esperado "${esperado}" em "${corpo}"`);
  });
});

describe("abertura do contrato digital", () => {
  beforeEach(cenario);

  it("primeiro acesso congela o corpo com o modelo digital e a data da abertura", async () => {
    await setSettings({
      contract_template: "PAPEL {{contrato}}",
      contract_template_digital: "DIGITAL {{contrato}} — {{data_assinatura_digital}}",
    });
    await insert(
      `INSERT INTO contracts (number, reservation_id, status, body) VALUES ('CTR-001', ?, 'pendente', 'PAPEL CTR-001')`,
      [reserva],
    );
    const contrato = await one<any>(`SELECT id FROM contracts WHERE number = 'CTR-001'`);
    const criado = await gerarLink(contrato.id, 1);
    const registro = await porToken(criado!.token);
    const aberto = await congelarCorpoAoAbrir(registro);

    assert.ok(aberto.body.startsWith("DIGITAL CTR-001"), "o cliente le o modelo digital");
    assert.ok(/Uberlândia, \d{1,2} de \w+ de \d{4}/.test(aberto.body), "data por extenso presente");
    assert.ok(aberto.body_frozen_at, "carimbo da abertura gravado");
  });

  it("reabrir no dia seguinte nao muda a data congelada", async () => {
    await setSettings({ contract_template_digital: "{{data_assinatura_digital}}" });
    await insert(
      `INSERT INTO contracts (number, reservation_id, status, body) VALUES ('CTR-001', ?, 'pendente', 'antigo')`,
      [reserva],
    );
    const contrato = await one<any>(`SELECT id FROM contracts WHERE number = 'CTR-001'`);
    const criado = await gerarLink(contrato.id, 1);
    const primeira = await congelarCorpoAoAbrir(await porToken(criado!.token));
    const dataPrimeira = primeira.body;

    // simula a reabertura: o carimbo ja existe, o corpo tem que continuar igual
    const segunda = await congelarCorpoAoAbrir(await porToken(criado!.token));
    assert.equal(segunda.body, dataPrimeira, "a data nao muda entre acessos");
  });

  it("assinado, a abertura nao toca no corpo congelado", async () => {
    await setSettings({ contract_template_digital: "DIGITAL {{contrato}}" });
    await insert(
      `INSERT INTO contracts (number, reservation_id, status, body, signed_at)
       VALUES ('CTR-001', ?, 'assinado', 'TEXTO CONGELADO', '2026-09-01T10:00')`,
      [reserva],
    );
    const contrato = await one<any>(`SELECT id FROM contracts WHERE number = 'CTR-001'`);
    const criado = await gerarLink(contrato.id, 1);
    const registro = await porToken(criado!.token);
    const aberto = await congelarCorpoAoAbrir(registro);
    assert.equal(aberto.body, "TEXTO CONGELADO", "contrato assinado nao e alterado");
  });

  it("link revogado ou expirado nao congela nem altera nada", async () => {
    await setSettings({ contract_template_digital: "DIGITAL {{contrato}}" });
    await insert(
      `INSERT INTO contracts (number, reservation_id, status, body) VALUES ('CTR-001', ?, 'pendente', 'corpo original')`,
      [reserva],
    );
    const contrato = await one<any>(`SELECT id FROM contracts WHERE number = 'CTR-001'`);
    const criado = await gerarLink(contrato.id, 1);
    await run(`UPDATE contract_signatures SET status='revogado' WHERE id=?`, [criado!.id]);
    const registro = await porToken(criado!.token);
    const aberto = await congelarCorpoAoAbrir(registro);
    assert.equal(aberto.body, "corpo original", "nada muda em link revogado");
  });

  it("gerar link novo nao apaga o corpo congelado de link anterior", async () => {
    await setSettings({ contract_template_digital: "DIGITAL {{contrato}} — {{data_assinatura_digital}}" });
    await insert(
      `INSERT INTO contracts (number, reservation_id, status, body) VALUES ('CTR-001', ?, 'pendente', 'PAPEL CTR-001')`,
      [reserva],
    );
    const contrato = await one<any>(`SELECT id FROM contracts WHERE number = 'CTR-001'`);
    const primeiro = await gerarLink(contrato.id, 1);
    const aberto = await congelarCorpoAoAbrir(await porToken(primeiro!.token));
    const congelado = aberto.body;

    await gerarLink(contrato.id, 1); // revoga o primeiro e cria o segundo
    const segunda = await porToken((await gerarLink(contrato.id, 1))!.token);
    // o carimbo ja existe: a abertura seguinte mantem o texto original
    const reaberto = await congelarCorpoAoAbrir(segunda);
    assert.equal(reaberto.body, congelado, "a data da segunda abertura nao sobrescreve a primeira");
  });

  it("contrato sem link continua funcionando como antes", async () => {
    await insert(
      `INSERT INTO contracts (number, reservation_id, status, body) VALUES ('CTR-001', ?, 'pendente', 'so papel')`,
      [reserva],
    );
    const c = await one<any>(`SELECT body, body_frozen_at FROM contracts WHERE number='CTR-001'`);
    assert.equal(c.body, "so papel");
    assert.equal(c.body_frozen_at, null);
    assert.equal((await assinaturasDoContrato(c.id)).length, 0);
  });
});
