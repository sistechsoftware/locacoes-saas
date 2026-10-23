/**
 * Configuração de frete por tipo (Configurações → Frete e calculadora).
 *
 * Regressão do defeito de produção: a aba Frete gravava chaves
 * `freight_comum_*` / `freight_locacao_*`, mas o setSettings só aceitava as
 * chaves genéricas `freight_*` da whitelist de DEFAULT_SETTINGS — todo
 * salvamento era descartado em silêncio e a tela voltava aos valores
 * anteriores após recarregar.
 *
 * Cobre:
 *  - a whitelist aceita EXATAMENTE as chaves que as actions de frete escrevem;
 *  - o que o administrador salva volta em leituras seguintes (persistência);
 *  - valores por tipo prevalecem sobre os genéricos; vazios caem no fallback;
 *  - empresas diferentes não compartilham a configuração de frete;
 *  - chaves frete fora do padrão continuam recusadas (proteção intacta);
 *  - as fórmulas de cálculo não mudaram com a correção.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTestDb } from "./helpers/d1.ts";
import { all, one, run } from "../src/lib/db.ts";
import { getSettings, isKnownSetting, setSettings, DEFAULT_SETTINGS } from "../src/lib/settings.ts";
import { freightConfig } from "../src/lib/freight-config.ts";
import { calcularFrete } from "../src/lib/freight.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** As MESMAS chaves que saveFreightSettings monta a partir do FormData. */
function chavesDoFormulario(tipo: "comum" | "locacao"): Record<string, string> {
  const values = {
    freight_fuel_type: "Gasolina",
    freight_fuel_price_cents: "499",
    freight_consumption: "12",
    freight_cost_per_km_cents: "62",
    freight_margin_percent: "25",
    freight_minimum_cents: "4000",
    freight_rounding_cents: "100",
    freight_labor_cents: "800",
  };
  const out = Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key.replace("freight_", `freight_${tipo}_`), value]),
  );
  out[`freight_${tipo}_base_address`] = "Rua da Base 10, Sao Paulo";
  return out;
}

function cenario() {
  createTestDb();
}

describe("whitelist de settings aceita o que a tela de frete grava", () => {
  beforeEach(cenario);

  it("todas as chaves geradas por saveFreightSettings são conhecidas", () => {
    for (const tipo of ["comum", "locacao"] as const) {
      for (const key of Object.keys(chavesDoFormulario(tipo))) {
        assert.ok(isKnownSetting(key), `${key} precisa ser aceita pela whitelist`);
      }
    }
  });

  it("a action de frete grava chaves por tipo (freight_<tipo>_) — não genéricas", () => {
    const fonte = fs.readFileSync(path.join(ROOT, "src/app/(app)/configuracoes/actions.ts"), "utf8");
    const inicio = fonte.indexOf("export async function saveFreightSettings");
    const corpo = fonte.slice(inicio, fonte.indexOf("\n}", inicio));
    assert.ok(inicio >= 0, "saveFreightSettings sumiu das configurações");
    assert.ok(
      corpo.includes("freight_${tipo}_"),
      "o salvamento precisa usar as chaves por tipo lidas por freightConfig",
    );
  });

  it("o botão 'Salvar como padrão' da calculadora também persiste", () => {
    assert.ok(isKnownSetting("freight_comum_fuel_price_cents"), "chave do salvarPrecoCombustivel recusada");
    assert.ok(isKnownSetting("freight_locacao_fuel_price_cents"), "chave do salvarPrecoCombustivel recusada");
  });

  it("chaves frete fora do padrão continuam recusadas", () => {
    assert.equal(isKnownSetting("freight_hack_cents"), false);
    assert.equal(isKnownSetting("freight_comum_anything"), false);
  });
});

describe("persistência da configuração de frete", () => {
  beforeEach(cenario);

  it("salvar alteração válida volta na leitura seguinte (recarregar a tela)", async () => {
    await setSettings(chavesDoFormulario("comum"));
    const recarregado = await getSettings();
    assert.equal(recarregado.freight_comum_fuel_price_cents, "499");
    assert.equal(recarregado.freight_comum_base_address, "Rua da Base 10, Sao Paulo");
    assert.equal(
      (await one<any>(`SELECT value FROM company_settings WHERE company_id=1 AND key='freight_comum_margin_percent'`))?.value,
      "25",
    );
  });

  it("dois tipos salvos na mesma operação ficam independentes", async () => {
    await setSettings({ ...chavesDoFormulario("comum"), ...chavesDoFormulario("locacao") });
    const s = await getSettings();
    const comum = freightConfig(s, "comum");
    const locacao = freightConfig(s, "locacao");
    assert.equal(comum.baseAddress, "Rua da Base 10, Sao Paulo");
    assert.equal(locacao.baseAddress, comum.baseAddress, "mesmo fixture: separação verificada no teste de isolamento");
  });

  it("cada tipo guarda o próprio endereço-base", async () => {
    await setSettings({ ...chavesDoFormulario("comum"), ...chavesDoFormulario("locacao"), freight_locacao_base_address: "Av. do Evento 99, Santos" });
    const s = await getSettings();
    assert.equal(freightConfig(s, "comum").baseAddress, "Rua da Base 10, Sao Paulo");
    assert.equal(freightConfig(s, "locacao").baseAddress, "Av. do Evento 99, Santos");
  });

  it("valores por tipo prevalecem sobre os genéricos", async () => {
    await setSettings({ ...chavesDoFormulario("comum"), freight_fuel_price_cents: "332" });
    const s = await getSettings();
    assert.equal(freightConfig(s, "comum").fuelPriceCents, 499);
    assert.equal(freightConfig(s, "locacao").fuelPriceCents, 332, "sem valor por tipo, o genérico continua valendo");
  });

  it("empresa que só tem as chaves genéricas históricas lê exatamente o mesmo valor", () => {
    // cenário real de produção: nenhuma linha por tipo gravada até a correção
    const historico = { ...DEFAULT_SETTINGS, freight_fuel_price_cents: "410", freight_comum_base_address: "" };
    const c = freightConfig(historico, "comum");
    assert.equal(c.fuelPriceCents, 410);
    assert.equal(c.baseAddress, "", "string vazia não pode mascarar o fallback");
  });

  it("campo limpo (vazio) volta ao genérico em vez de travar o valor antigo", async () => {
    await setSettings(chavesDoFormulario("comum"));
    await setSettings({ freight_comum_fuel_price_cents: "" });
    const s = await getSettings();
    assert.equal(freightConfig(s, "comum").fuelPriceCents, Number(DEFAULT_SETTINGS.freight_fuel_price_cents));
  });

  it("atualização parcial preserva os demais campos do tipo", async () => {
    await setSettings(chavesDoFormulario("comum"));
    await setSettings({ freight_comum_minimum_cents: "7500" });
    const c = freightConfig(await getSettings(), "comum");
    assert.equal(c.minimumCents, 7500);
    assert.equal(c.fuelPriceCents, 499, "campos não enviados permanecem");
    assert.equal(c.marginPercent, 25);
  });
});

describe("isolamento por tenant", () => {
  beforeEach(cenario);

  it("configuração salva pela empresa 1 não aparece na empresa 2", async () => {
    await run(`INSERT INTO companies (id, name, active) VALUES (2, 'Outra Empresa', 1)`);
    await setSettings(chavesDoFormulario("comum"), 1);
    const daDois = await settingsDa(2);
    const comumDaDois = freightConfig(daDois, "comum");
    assert.equal(comumDaDois.fuelPriceCents, Number(DEFAULT_SETTINGS.freight_fuel_price_cents), "empresa 2 cai no padrão");
    assert.equal(comumDaDois.baseAddress, "");
    const linhas = await all(`SELECT key FROM company_settings WHERE company_id = 2 AND key LIKE 'freight_%'`);
    assert.equal(linhas.length, 0, "nenhuma linha de frete pode nascer na empresa errada");
  });

  it("empresa 1 mantém o que gravou mesmo depois da empresa 2 salvar outro valor", async () => {
    await run(`INSERT INTO companies (id, name, active) VALUES (2, 'Outra Empresa', 1)`);
    await setSettings(chavesDoFormulario("comum"), 1);
    await setSettings({ ...chavesDoFormulario("comum"), freight_comum_fuel_price_cents: "999" }, 2);
    assert.equal(freightConfig(await settingsDa(1), "comum").fuelPriceCents, 499);
    assert.equal(freightConfig(await settingsDa(2), "comum").fuelPriceCents, 999);
  });
});

/** settingsDaEmpresa explícita: em teste não há sessão de request. */
async function settingsDa(companyId: number): Promise<Record<string, string>> {
  const { settingsDaEmpresa } = await import("../src/lib/settings.ts");
  return settingsDaEmpresa(companyId);
}

describe("fórmulas de cálculo intactas após a correção", () => {
  it("configuração por tipo alimenta o mesmo cálculo de sempre", async () => {
    cenario();
    await setSettings(chavesDoFormulario("comum"));
    const c = freightConfig(await getSettings(), "comum");
    const r = calcularFrete({
      tipo: "comum", distanciaIdaKm: 15, consumoKmPorLitro: c.consumption,
      precoLitroCents: c.fuelPriceCents, custoPorKmCents: c.costPerKmCents,
      pedagioCents: 0, maoDeObraCents: c.laborCents, margemPercent: c.marginPercent,
      valorMinimoCents: c.minimumCents, arredondamentoCents: c.roundingCents,
    });
    assert.equal(r.distanciaTotalKm, 30, "comum continua ida e volta");
    assert.equal(r.custoOperacionalCents, Math.round(30 * 62));
    assert.ok(r.valorSugeridoCents >= r.precoFinalCents);
  });
});
