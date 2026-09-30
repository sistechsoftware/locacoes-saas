/**
 * Financeiro da plataforma (painel /saas): cobranças por empresa, receita do
 * mês, PIX pendentes, inadimplência e eventos do webhook. FakeD1 completo.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createTestDb, resetTestDb } from "./helpers/d1.ts";
import { insert, resetCompanyCache, run } from "../src/lib/db.ts";

beforeEach(async () => {
  createTestDb();
  resetCompanyCache();
  await run(`DELETE FROM subscription_payments`);
  await run(`DELETE FROM subscriptions`);
  await run(`DELETE FROM companies WHERE id > 1`);
  await run(`UPDATE companies SET name='Plataforma' WHERE id=1`);
  await run(`INSERT INTO companies (id, name, active) VALUES (2, 'Locadora Alfa', 1)`);
  // Plano 1 (essencial) já vem do catálogo das migrations.
  await run(
    `INSERT INTO subscriptions (company_id, plan_id, status) VALUES (2, 1, 'active')`,
  );
});

function paidHoje(): string {
  return new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 19).replace("T", " ");
}

function diaBR(offset: number): string {
  return new Date(Date.now() - 3 * 3600000 + offset * 86400000).toISOString().slice(0, 10);
}

async function semearCobrancas() {
  const sub = await insert(
    `INSERT INTO subscription_payments (company_id, subscription_id, asaas_payment_id, amount_cents, status, due_date, paid_at)
     VALUES (2, 1, 'pay_pago', 7990, 'received', ?, ?)`,
    [diaBR(-30), paidHoje()],
  );
  await insert(
    `INSERT INTO subscription_payments (company_id, subscription_id, asaas_payment_id, amount_cents, status, due_date)
     VALUES (2, 1, 'pay_pendente', 7990, 'pending', ?)`,
    [diaBR(10)],
  );
  await insert(
    `INSERT INTO subscription_payments (company_id, subscription_id, asaas_payment_id, amount_cents, status, due_date)
     VALUES (2, 1, 'pay_vencida', 7990, 'overdue', ?)`,
    [diaBR(-5)],
  );
  return sub;
}

describe("resumoFinanceiroPainel", () => {
  it("soma receita do mês, PIX pendentes e inadimplência", async () => {
    await semearCobrancas();
    const { resumoFinanceiroPainel } = await import("../src/lib/billing.ts");
    const r = await resumoFinanceiroPainel();
    assert.equal(r.recebido, 7990, "só a cobrança received conta no mês");
    assert.equal(r.pixPendentes, 7990);
    assert.equal(r.pixPendentesQtd, 1);
    assert.equal(r.inadimplencia, 7990, "overdue vencida entra na inadimplência");
    assert.equal(r.inadimplentesQtd, 1, "uma empresa inadimplente");
  });

  it("pendente ainda NÃO vencida não é inadimplência", async () => {
    await insert(
      `INSERT INTO subscription_payments (company_id, subscription_id, asaas_payment_id, amount_cents, status, due_date)
       VALUES (2, 1, 'pay_futuro', 7990, 'pending', ?)`,
      [diaBR(10)],
    );
    const { resumoFinanceiroPainel } = await import("../src/lib/billing.ts");
    const r = await resumoFinanceiroPainel();
    assert.equal(r.pixPendentes, 7990);
    assert.equal(r.inadimplencia, 0);
    assert.equal(r.inadimplentesQtd, 0);
  });
});

describe("listarCobrancasPainel", () => {
  it("enriquece com empresa/plano e prioriza não pagas", async () => {
    await semearCobrancas();
    const { listarCobrancasPainel } = await import("../src/lib/billing.ts");
    const lista = await listarCobrancasPainel();
    assert.equal(lista.length, 3);
    const primeira = lista[0];
    assert.equal(primeira.empresa, "Locadora Alfa");
    assert.equal(primeira.plano, "Essencial");
    assert.ok(primeira.status === "pending" || primeira.status === "overdue", "não pagas primeiro");
    const paga = lista.find((c) => c.status === "received");
    assert.ok(paga, "cobrança paga presente");
    assert.equal(paga!.asaas_payment_id, "pay_pago");
  });
});

describe("listarEventosWebhookPainel", () => {
  it("lista os últimos eventos com estado de processamento", async () => {
    await run(`INSERT INTO webhook_events (event, payload, payload_hash, handled, error) VALUES
      ('PAYMENT_CREATED', '{}', 'h1', 1, NULL),
      ('PAYMENT_RECEIVED', '{}', 'h2', 1, NULL),
      ('PAYMENT_REFUNDED', '{}', 'h3', 0, 'payment sem correspondencia local')`);
    const { listarEventosWebhookPainel } = await import("../src/lib/billing.ts");
    const eventos = await listarEventosWebhookPainel(10);
    assert.equal(eventos.length, 3);
    assert.equal(eventos[0].event, "PAYMENT_REFUNDED", "mais recente primeiro");
    assert.equal(eventos[0].handled, 0);
    assert.match(eventos[0].error ?? "", /correspondencia/);
    assert.equal(eventos[2].event, "PAYMENT_CREATED");
  });
});
