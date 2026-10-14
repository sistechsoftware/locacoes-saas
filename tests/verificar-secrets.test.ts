/**
 * Pré-deploy (scripts/verificar-secrets.mjs) — pendência #08 com o caminho do
 * painel: as credenciais Asaas podem vir do secret do Worker OU do painel
 * /saas (platform_settings), resolvidas campo a campo como o Worker faz em
 * runtime (secret > painel > ausente). O valor de asaas_environment vindo do
 * painel é conferido: produção SÓ aceita "production" (sandbox em produção é
 * bloqueio — a cobrança real nunca aconteceria).
 *
 * Testa as funções puras exportadas pelo script e o comportamento de CLI no
 * modo offline (--sem-remoto), sem tocar em rede/Worker.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  TRIO_ASAAS,
  resolverTrio,
  regraAmbiente,
  segredoCifrado,
} from "../scripts/verificar-secrets.mjs";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(RAIZ, "scripts", "verificar-secrets.mjs");

const painelCompleto = {
  asaas_api_key: "enc:v1:abc",
  asaas_environment: "sandbox",
  asaas_webhook_token: "enc:v1:def",
};

describe("resolverTrio (secret do Worker > painel > ausente)", () => {
  it("trio completo no Worker: tudo resolvido pelo secret, sem painel", () => {
    const r = resolverTrio(new Set(TRIO_ASAAS), {});
    assert.deepEqual(
      TRIO_ASAAS.map((s) => r.campos[s].origem),
      ["worker", "worker", "worker"],
    );
    assert.deepEqual(r.faltando, []);
    assert.deepEqual(r.misto, []);
  });

  it("sem secret: trio completo vem do painel, com os valores do painel", () => {
    const r = resolverTrio(new Set(), painelCompleto);
    assert.deepEqual(
      TRIO_ASAAS.map((s) => r.campos[s].origem),
      ["painel", "painel", "painel"],
    );
    assert.equal(r.campos.ASAAS_ENVIRONMENT.valor, "sandbox");
    assert.deepEqual(r.faltando, []);
    assert.deepEqual(r.misto, []);
  });

  it("mistura: secret cobre só a key; ambiente e token vêm do painel; misto sinaliza a key", () => {
    const r = resolverTrio(new Set(["ASAAS_API_KEY"]), painelCompleto);
    assert.equal(r.campos.ASAAS_API_KEY.origem, "worker");
    assert.equal(r.campos.ASAAS_ENVIRONMENT.origem, "painel");
    assert.equal(r.campos.ASAAS_WEBHOOK_TOKEN.origem, "painel");
    assert.deepEqual(r.faltando, []);
    assert.deepEqual(r.misto, ["ASAAS_API_KEY"]);
  });

  it("secret e painel no mesmo campo: o secret vence e o campo fica em misto", () => {
    const r = resolverTrio(new Set(TRIO_ASAAS), painelCompleto);
    assert.deepEqual(
      TRIO_ASAAS.map((s) => r.campos[s].origem),
      ["worker", "worker", "worker"],
    );
    assert.deepEqual(r.misto, [...TRIO_ASAAS]);
  });

  it("nem secret nem painel: os três campos ficam em faltando", () => {
    const r = resolverTrio(new Set(), {});
    assert.deepEqual(r.faltando, [...TRIO_ASAAS]);
  });

  it("painel parcial: só o que falta sem os dois caminhos entra em faltando", () => {
    const r = resolverTrio(new Set(), { asaas_environment: "production" });
    assert.deepEqual(r.faltando, ["ASAAS_API_KEY", "ASAAS_WEBHOOK_TOKEN"]);
    assert.equal(r.campos.ASAAS_ENVIRONMENT.origem, "painel");
  });
});

describe("regraAmbiente (valor de asaas_environment do painel)", () => {
  it("produção só aceita production: sandbox é bloqueio", () => {
    const r = regraAmbiente("production", "painel", "sandbox");
    assert.ok(r.falha, "sandbox em produção precisa bloquear o deploy");
    assert.match(r.falha!, /sandbox/);
    assert.match(r.falha!, /production/);
  });

  it("produção com production é aceita", () => {
    assert.deepEqual(regraAmbiente("production", "painel", "production"), {});
  });

  it("staging com sandbox é aceita", () => {
    assert.deepEqual(regraAmbiente("staging", "painel", "sandbox"), {});
  });

  it("staging apontando para a API real é aviso, não bloqueio", () => {
    const r = regraAmbiente("staging", "painel", "production");
    assert.ok(r.aviso, "staging em production precisa avisar");
    assert.equal(r.falha, undefined);
  });

  it("valor vindo do secret do Worker não é legível aqui: não bloqueia", () => {
    assert.deepEqual(regraAmbiente("production", "worker", null), {});
  });
});

describe("segredoCifrado (invariante: segredo do painel nunca em claro)", () => {
  it("chave e token precisam do prefixo enc:v1:", () => {
    assert.equal(segredoCifrado("asaas_api_key", "enc:v1:xyz"), true);
    assert.equal(segredoCifrado("asaas_webhook_token", "enc:v1:xyz"), true);
    assert.equal(segredoCifrado("asaas_api_key", "$aact_123"), false);
    assert.equal(segredoCifrado("asaas_webhook_token", "token-claro"), false);
  });

  it("asaas_environment é texto público: em claro é aceito", () => {
    assert.equal(segredoCifrado("asaas_environment", "production"), true);
    assert.equal(segredoCifrado("asaas_environment", "sandbox"), true);
  });
});

describe("CLI do pré-deploy (modo offline)", () => {
  it("sem argumento: sai com código de uso (2)", () => {
    const r = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8" });
    assert.equal(r.status, 2);
    assert.match(String(r.stderr), /Uso:/);
  });

  it("production --sem-remoto: avisa que não conferiu e sai 0 (sem rede)", () => {
    const r = spawnSync(process.execPath, [SCRIPT, "production", "--sem-remoto"], { encoding: "utf8" });
    assert.equal(r.status, 0, `saída inesperada:\n${r.stdout}\n${r.stderr}`);
    assert.match(String(r.stdout), /--sem-remoto/);
    assert.match(String(r.stdout), /Pré-deploy OK/);
  });
});
