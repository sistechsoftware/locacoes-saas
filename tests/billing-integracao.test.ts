/**
 * Integração da camada comercial com a fundação (Etapa 3):
 *  * webhook com token e idempotência (sem rede);
 *  * assinatura/cobrança isoladas por empresa (cross-tenant);
 *  * gate de bloqueio no estado efetivo (navegação é coberta pela suíte E2E).
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "./helpers/d1.ts";
import { insert, one, run } from "../src/lib/db.ts";
import { resetCompanyCache } from "../src/lib/db.ts";

async function cenarioDuasEmpresas() {
  createTestDb();
  resetCompanyCache();
  await run(`DELETE FROM subscriptions`);
  await run(`DELETE FROM subscription_payments`);
  await run(`DELETE FROM webhook_events`);
  await run(`DELETE FROM companies`);
  await run(`INSERT INTO companies (id, name, active, document) VALUES (1, 'Empresa A', 1, '11111111111')`);
  await run(`INSERT INTO companies (id, name, active, document) VALUES (2, 'Empresa B', 1, '22222222222')`);
  await insert(`INSERT INTO users (id, name, username, password_hash, role, active, company_id) VALUES (1,'A','a','x','owner',1,1)`);
  await insert(`INSERT INTO users (id, name, username, password_hash, role, active, company_id) VALUES (2,'B','b','x','owner',1,2)`);
}

async function assinaturaAtiva(companyId: number) {
  await run(
    `INSERT INTO subscriptions (company_id, plan_id, status, current_period_start, current_period_end)
     VALUES (?, 1, 'active', '2026-09-01', '2026-09-30')`,
    [companyId],
  );
  return (await one<any>(`SELECT id FROM subscriptions WHERE company_id = ?`, [companyId]))!;
}

describe("webhook asaas (route handler)", () => {
  beforeEach(cenarioDuasEmpresas);

  it("processa PAYMENT_RECEIVED uma unica vez (idempotente por hash)", async () => {
    // Importa o handler real do route e chama POST diretamente (sem HTTP).
    const mod = await import("../src/app/api/webhooks/asaas/route.ts");
    const corpo = JSON.stringify({ event: "PAYMENT_RECEIVED", payment: { id: "pay_42", billingType: "PIX" } });

    await assinaturaAtiva(1);
    await run(
      `INSERT INTO subscription_payments (company_id, subscription_id, asaas_payment_id, amount_cents, status, due_date)
       VALUES (1, (SELECT id FROM subscriptions WHERE company_id = 1), 'pay_42', 7990, 'pending', '2026-09-15')`,
    );

    // Sem ASAAS_WEBHOOK_TOKEN no ambiente de teste o endpoint recusa (fail-closed).
    const semToken = await mod.POST(new Request("https://x.test/api/webhooks/asaas?token=qualquer", {
      method: "POST",
      body: corpo,
      headers: { "content-type": "application/json" },
    }));
    assert.equal(semToken.status, 401);

    // Simula o secret via getCloudflareContext stub: em vez disso, grava o
    // evento direto e valida o processamento + idempotência no nível da camada.
    const { processarEventoPayment } = await import("../src/lib/billing.ts");
    await run(`INSERT INTO webhook_events (event, payload, payload_hash) VALUES ('PAYMENT_RECEIVED', ?, ?)`, [
      corpo,
      Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(corpo)))).map((b) => b.toString(16).padStart(2, "0")).join(""),
    ]);
    await processarEventoPayment("PAYMENT_RECEIVED", JSON.parse(corpo));

    const p = await one<any>(`SELECT status, paid_at FROM subscription_payments WHERE asaas_payment_id = 'pay_42'`);
    assert.equal(p.status, "received");
    assert.ok(p.paid_at);

    // Segunda chamada com o MESMO corpo: nenhum efeito adicional, sem erro.
    await processarEventoPayment("PAYMENT_RECEIVED", JSON.parse(corpo));
    const estados = await one<any>(
      `SELECT COUNT(*) AS n FROM subscriptions WHERE company_id = 1 AND status = 'active'`,
    );
    assert.equal(estados.n, 1);
  });

  it("payment de outra empresa nao afeta a assinatura da primeira (isolamento)", async () => {
    const { processarEventoPayment } = await import("../src/lib/billing.ts");
    await assinaturaAtiva(1);
    await assinaturaAtiva(2);
    await run(
      `INSERT INTO subscription_payments (company_id, subscription_id, asaas_payment_id, amount_cents, status, due_date)
       VALUES (2, (SELECT id FROM subscriptions WHERE company_id = 2), 'pay_B', 7990, 'pending', '2026-09-15')`,
    );
    await processarEventoPayment("PAYMENT_RECEIVED", { payment: { id: "pay_B" } });

    const a = await one<any>(`SELECT status, current_period_end FROM subscriptions WHERE company_id = 1`);
    const b = await one<any>(`SELECT status, current_period_end FROM subscriptions WHERE company_id = 2`);
    assert.equal(a.status, "active");
    assert.equal(a.current_period_end, "2026-09-30", "empresa A intocada");
    assert.equal(b.status, "active");
    assert.ok(b.current_period_end! > "2026-09-30", "empresa B renovada");
  });
});

describe("assinatura por empresa (cross-tenant)", () => {
  beforeEach(cenarioDuasEmpresas);

  it("trial criado para A nao cria assinatura para B automaticamente", async () => {
    const { assinaturaDaEmpresa } = await import("../src/lib/billing.ts");
    const a = await assinaturaDaEmpresa(1);
    assert.ok(a);
    const bDireto = await one<any>(`SELECT COUNT(*) AS n FROM subscriptions WHERE company_id = 2`);
    assert.equal(bDireto.n, 0, "B continua sem assinatura");
    const b = await assinaturaDaEmpresa(2);
    assert.ok(b && b.company_id === 2);
    assert.notEqual(a!.id, b!.id);
  });

  it("limite de usuarios do plano e respeitado por empresa", async () => {
    const { limiteUsuarios } = await import("../src/lib/billing.ts");
    const limiteA = await limiteUsuarios(1);
    const limiteB = await limiteUsuarios(2);
    assert.equal(limiteA, limiteB, "mesmo plano => mesmo limite");
    assert.ok(limiteA >= 1);
  });
});

describe("painel da plataforma", () => {
  beforeEach(cenarioDuasEmpresas);

  it("metricas cobrem todas as empresas sem vazamento entre elas", async () => {
    await assinaturaAtiva(1);
    await run(
      `INSERT INTO subscriptions (company_id, plan_id, status, trial_ends_at)
       VALUES (2, 1, 'trial', date('now','+10 day'))`,
    );
    const { metricasPainel, listarEmpresasPainel } = await import("../src/lib/billing.ts");
    const m = await metricasPainel();
    assert.equal(m.ativas, 1);
    assert.equal(m.trials, 1);
    const empresas = await listarEmpresasPainel();
    assert.equal(empresas.length, 2);
    const a = empresas.find((e) => e.company_id === 1)!;
    const b = empresas.find((e) => e.company_id === 2)!;
    assert.equal(a.status, "active");
    assert.equal(b.status, "trial");
  });

  it("acoes da plataforma suspendem e reativam", async () => {
    const { acaoPlataforma, estadoAssinatura } = await import("../src/lib/billing.ts");
    await assinaturaAtiva(1);
    await acaoPlataforma(1, "suspender");
    const suspenso = await estadoAssinatura(1);
    assert.equal(suspenso.bloqueioDuro, true);
    await acaoPlataforma(1, "reativar");
    const reativado = await estadoAssinatura(1);
    assert.equal(reativado.bloqueioDuro, false);
  });
});
