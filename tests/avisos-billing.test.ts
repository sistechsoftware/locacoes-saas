/**
 * Avisos comerciais da rotina de billing (Etapa 5): e-mail de trial acabando
 * e expirado, deduplicado por billing_alerts — o cron roda a cada minuto, o
 * aviso tem que sair UMA vez.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "./helpers/d1.ts";
import { one, resetCompanyCache, run } from "../src/lib/db.ts";
import { __definirEmailTeste, __emailsEnviados } from "../src/lib/email.ts";

function diaBR(offset: number): string {
  return new Date(Date.now() - 3 * 3600000 + offset * 86400000).toISOString().slice(0, 10);
}

async function cenario() {
  createTestDb();
  resetCompanyCache();
  __definirEmailTeste(null);
  __emailsEnviados.length = 0; // array acumulativo: limpa entre os testes
  await run(`DELETE FROM billing_alerts`);
  await run(`DELETE FROM subscriptions`);
  await run(`DELETE FROM subscription_payments`);
  await run(`DELETE FROM companies`);
  await run(`DELETE FROM users`);
  await run(`INSERT INTO companies (id, name, active) VALUES (1, 'Locadora Teste', 1)`);
  await run(
    `INSERT INTO users (id, name, username, password_hash, role, active, company_id, email)
     VALUES (1, 'Owner', 'owner', 'x', 'owner', 1, 1, 'dono@locadora.test')`,
  );
}

function emailConfigFake() {
  return {
    apiKey: "k",
    from: "f@x.com",
    fetchImpl: (async () => new Response("{}", { status: 200 })) as any,
  };
}

beforeEach(cenario);

describe("avisos de trial na rotina diária", () => {
  it("trial acabando (3 dias) envia 1 aviso; rodada seguinte no mesmo dia não reenvia", async () => {
    const billing = await import("../src/lib/billing.ts");
    __definirEmailTeste(emailConfigFake());
    await run(
      `INSERT INTO subscriptions (company_id, plan_id, status, trial_ends_at, current_period_start, current_period_end)
       VALUES (1, 1, 'trial', ?, ?, ?)`,
      [diaBR(2), diaBR(0), diaBR(2)],
    );

    const r1 = await billing.rotinaDiariaBilling();
    assert.equal(r1.avisosTrialEnviados, 1);
    assert.equal(__emailsEnviados.length, 1);
    assert.match(__emailsEnviados[0].to, /dono@locadora\.test/);
    assert.match(__emailsEnviados[0].html, /termina em/);

    // Segunda execução no mesmo dia: dedupe por chave única.
    const r2 = await billing.rotinaDiariaBilling();
    assert.equal(r2.avisosTrialEnviados, 0);
    assert.equal(__emailsEnviados.length, 1, "nenhum reenvio");
    const marcas = await one<any>(`SELECT COUNT(*) AS n FROM billing_alerts`);
    assert.equal(marcas.n, 1);
  });

  it("trial expirado é suspenso e o owner recebe o aviso de reativação", async () => {
    const billing = await import("../src/lib/billing.ts");
    __definirEmailTeste(emailConfigFake());
    await run(
      `INSERT INTO subscriptions (company_id, plan_id, status, trial_ends_at, current_period_start, current_period_end)
       VALUES (1, 1, 'trial', ?, ?, ?)`,
      [diaBR(-1), diaBR(-14), diaBR(-1)],
    );

    const r = await billing.rotinaDiariaBilling();
    assert.equal(r.trialsExpirados, 1);
    assert.equal(r.avisosTrialEnviados, 1);
    const sub = await one<any>(`SELECT status FROM subscriptions WHERE company_id = 1`);
    assert.equal(sub.status, "suspended");
    assert.match(__emailsEnviados[0].html, /bloqueado/);
  });

  it("owner sem e-mail não gera reenvio infinito (chave marcada assim mesmo)", async () => {
    const billing = await import("../src/lib/billing.ts");
    __definirEmailTeste(emailConfigFake());
    await run(`UPDATE users SET email = NULL WHERE id = 1`);
    await run(
      `INSERT INTO subscriptions (company_id, plan_id, status, trial_ends_at, current_period_start, current_period_end)
       VALUES (1, 1, 'trial', ?, ?, ?)`,
      [diaBR(2), diaBR(0), diaBR(2)],
    );

    const r1 = await billing.rotinaDiariaBilling();
    assert.equal(r1.avisosTrialEnviados, 0);
    assert.equal(__emailsEnviados.length, 0);
    const marcas = await one<any>(`SELECT COUNT(*) AS n FROM billing_alerts`);
    assert.equal(marcas.n, 1, "marcado para não martelar a cada minuto");
    const r2 = await billing.rotinaDiariaBilling();
    assert.equal(r2.avisosTrialEnviados, 0);
  });
});
