/**
 * Configurações da plataforma pelo painel /saas (migration 0038):
 *  * segredo é CIFRADO antes de ir ao banco (nunca em claro num dump do D1);
 *  * sem PAINEL_CHAVE a gravação de segredo é RECUSADA (fail-closed);
 *  * valor não-sensível (ambiente) fica em claro de propósito;
 *  * prioridade de leitura: secret do Worker > painel > ausente.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createTestDb, resetTestDb } from "./helpers/d1.ts";
import { one, run } from "../src/lib/db.ts";

const CHAVE = "chave-de-teste-do-painel-32bytes!!";

beforeEach(async () => {
  createTestDb();
  const ps = await import("../src/lib/platform-settings.ts");
  ps.__definirChavePainelTeste(CHAVE);
});

afterEach(() => {
  resetTestDb();
});

describe("platform_settings — cifra", () => {
  it("segredo vai ao banco cifrado e volta decifrado", async () => {
    const ps = await import("../src/lib/platform-settings.ts");
    await ps.gravarConfig("asaas_api_key", "$aact_prod_super_secreta");

    const bruto = await one<{ value: string }>(
      `SELECT value FROM platform_settings WHERE key = 'asaas_api_key'`,
    );
    assert.ok(bruto, "linha gravada");
    assert.ok(!bruto.value.includes("$aact_prod"), "valor não pode estar em claro");
    assert.ok(bruto.value.startsWith("enc:v1:"), "prefixo de cifra presente");
    assert.ok(!bruto.value.includes("super_secreta"), "plaintext ausente do dump");

    assert.equal(await ps.lerConfig("asaas_api_key"), "$aact_prod_super_secreta");
  });

  it("valor não-sensível fica em claro e é legível", async () => {
    const ps = await import("../src/lib/platform-settings.ts");
    await ps.gravarConfig("asaas_environment", "production");
    const bruto = await one<{ value: string }>(
      `SELECT value FROM platform_settings WHERE key = 'asaas_environment'`,
    );
    assert.equal(bruto?.value, "production");
    assert.equal(await ps.lerConfig("asaas_environment"), "production");
  });

  it("segredo sem PAINEL_CHAVE é RECUSADO — nada cai em claro", async () => {
    const ps = await import("../src/lib/platform-settings.ts");
    ps.__definirChavePainelTeste(null);
    await assert.rejects(() => ps.gravarConfig("asaas_api_key", "$aact_qualquer"), /PAINEL_CHAVE/);
    const linha = await one(`SELECT value FROM platform_settings WHERE key = 'asaas_api_key'`);
    assert.equal(linha, undefined, "nenhuma linha criada");
  });

  it("segredo cifrado com chave antiga não decifra: vira null, não lança", async () => {
    const ps = await import("../src/lib/platform-settings.ts");
    await ps.gravarConfig("asaas_webhook_token", "whsec_original");
    ps.__definirChavePainelTeste("outra-chave-bem-diferente");
    assert.equal(await ps.lerConfig("asaas_webhook_token"), null);
  });
});

describe("platform_settings — validação", () => {
  it("ambiente fora de sandbox/production é recusado", async () => {
    const ps = await import("../src/lib/platform-settings.ts");
    await assert.rejects(() => ps.gravarConfig("asaas_environment", "staging"), /sandbox/);
  });

  it("chave desconhecida é recusada (tabela não vira depósito livre)", async () => {
    const ps = await import("../src/lib/platform-settings.ts");
    await assert.rejects(
      () => ps.gravarConfig("qualquer_coisa" as never, "x"),
      /desconhecida/,
    );
  });

  it("valor vazio APAGA a configuração", async () => {
    const ps = await import("../src/lib/platform-settings.ts");
    await ps.gravarConfig("asaas_api_key", "$aact_tmp");
    assert.equal(await ps.configGravada("asaas_api_key"), true);
    await ps.gravarConfig("asaas_api_key", "   ");
    assert.equal(await ps.configGravada("asaas_api_key"), false);
    assert.equal(await ps.lerConfig("asaas_api_key"), null);
  });
});

describe("credenciaisAsaas — resolução", () => {
  it("sem nada nos dois lugares: tudo ausente", async () => {
    const ps = await import("../src/lib/platform-settings.ts");
    const c = await ps.credenciaisAsaas();
    assert.equal(c.apiKey, null);
    assert.equal(c.webhookToken, null);
    assert.equal(c.origem.apiKey, "ausente");
    assert.equal(c.origem.webhookToken, "ausente");
  });

  it("cadastro do painel alimenta as credenciais e o webhook", async () => {
    const ps = await import("../src/lib/platform-settings.ts");
    await ps.gravarConfig("asaas_api_key", "$aact_do_painel");
    await ps.gravarConfig("asaas_environment", "production");
    await ps.gravarConfig("asaas_webhook_token", "whsec_do_painel");

    const c = await ps.credenciaisAsaas();
    assert.equal(c.apiKey, "$aact_do_painel");
    assert.equal(c.environment, "production");
    assert.equal(c.webhookToken, "whsec_do_painel");
    // Fora do Worker não há secret, então a origem é o painel.
    assert.equal(c.origem.apiKey, "painel");
    assert.equal(c.origem.webhookToken, "painel");
  });

  it("asaasEnvironment passa a enxergar o painel (não fica 'nao_configurado')", async () => {
    const ps = await import("../src/lib/platform-settings.ts");
    const { asaasEnvironment } = await import("../src/lib/asaas.ts");
    assert.equal(await asaasEnvironment(), "nao_configurado", "antes de configurar");

    await ps.gravarConfig("asaas_api_key", "$aact_qualquer");
    await ps.gravarConfig("asaas_environment", "production");
    assert.equal(await asaasEnvironment(), "producao");

    await ps.gravarConfig("asaas_environment", "sandbox");
    assert.equal(await asaasEnvironment(), "sandbox");
  });
});
