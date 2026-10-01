/**
 * Camada comercial (Etapa 3): trial, bloqueio, troca de plano, cobrança PIX
 * (Asaas fake via gancho de teste, sem rede) e rotina diária de inadimplência.
 *
 * Todas as datas manipuladas nos testes são geradas no fuso de Brasília
 * (America/Sao_Paulo), o mesmo que o código usa — manipular o relógio por
 * UTC fez datas divergirem perto da meia-noite.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "./helpers/d1.ts";
import { insert, one, run, resetCompanyCache } from "../src/lib/db.ts";

/** Dia de Brasília com offset em dias (ex.: -1 = ontem). */
function diaBR(offset: number): string {
  return new Date(Date.now() - 3 * 3600000 + offset * 86400000).toISOString().slice(0, 10);
}

async function cenario() {
  createTestDb();
  resetCompanyCache();
  await run(`DELETE FROM subscriptions`);
  await run(`DELETE FROM subscription_payments`);
  await run(`DELETE FROM webhook_events`);
  await run(`DELETE FROM companies`);

  // CPF válido (dígitos verificadores conferidos) — a cobrança recusa
  // documento malformado antes de chamar o Asaas.
  await run(
    `INSERT INTO companies (id, name, active, document, email) VALUES (1, 'Empresa Demo', 1, '11144477735', 'demo@teste.com')`,
  );
  await insert(
    `INSERT INTO users (id, name, username, password_hash, role, active, company_id) VALUES (1,'Owner','owner','x','owner',1,1)`,
  );
}

async function assinaturaAtiva(status = "active") {
  await run(
    `INSERT INTO subscriptions (company_id, plan_id, status, current_period_start, current_period_end)
     VALUES (1, 1, ?, '2026-09-01', '2026-09-30')`,
    [status],
  );
  return (await one<any>(`SELECT id FROM subscriptions WHERE company_id = 1`))!;
}

describe("trial e bloqueio", () => {
  beforeEach(cenario);

  it("empresa sem assinatura ganha trial automaticamente na primeira consulta", async () => {
    const { assinaturaDaEmpresa, estadoAssinatura } = await import("../src/lib/billing.ts");
    const sub = await assinaturaDaEmpresa(1);
    assert.ok(sub);
    assert.equal(sub!.status, "trial");
    const estado = await estadoAssinatura(1);
    assert.equal(estado.status, "trial");
    assert.equal(estado.bloqueada, false);
    assert.ok((estado.diasRestantes ?? 0) > 10, "trial de 14 dias tem ~14 dias restantes");
  });

  it("trial expirado bloqueia (bloqueio duro)", async () => {
    const { estadoAssinatura } = await import("../src/lib/billing.ts");
    const ontem = diaBR(-1);
    await run(
      `INSERT INTO subscriptions (company_id, plan_id, status, trial_ends_at, current_period_start, current_period_end)
       VALUES (1, 1, 'trial', ?, ?, ?)`,
      [ontem, ontem, ontem],
    );
    const estado = await estadoAssinatura(1);
    assert.equal(estado.bloqueada, true);
    assert.equal(estado.bloqueioDuro, true);
  });

  it("trial vencido com pagamento confirmado fica ativo via webhook", async () => {
    const { processarEventoPayment, estadoAssinatura } = await import("../src/lib/billing.ts");
    const ontem = diaBR(-1);
    await run(
      `INSERT INTO subscriptions (company_id, plan_id, status, trial_ends_at, current_period_start, current_period_end)
       VALUES (1, 1, 'trial', ?, ?, ?)`,
      [ontem, ontem, ontem],
    );
    const sub = await one<any>(`SELECT id FROM subscriptions WHERE company_id = 1`);
    await run(
      `INSERT INTO subscription_payments (company_id, subscription_id, asaas_payment_id, amount_cents, status, due_date)
       VALUES (1, ?, 'pay_1', 7990, 'pending', ?)`,
      [sub.id, ontem],
    );
    await processarEventoPayment("PAYMENT_RECEIVED", { payment: { id: "pay_1", billingType: "PIX" } });
    const estado = await estadoAssinatura(1);
    assert.equal(estado.status, "active");
    assert.equal(estado.bloqueada, false);
  });
});

describe("cobranca PIX (Asaas fake via gancho)", () => {
  beforeEach(cenario);

  it("gera cobranca, registra pagamento com periodo de 30 dias e busca cliente por documento", async () => {
    const billing = await import("../src/lib/billing.ts");
    const chamadas: { url: string; method: string; body: any }[] = [];
    const fakeFetch = (async (url: any, init: any) => {
      const u = String(url);
      chamadas.push({ url: u, method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body) : null });
      if (u.includes("/v3/customers?")) {
        return new Response(
          JSON.stringify({ data: [{ id: "cus_1", name: "Empresa Demo", cpfCnpj: "12345678901" }] }),
          { status: 200 },
        );
      }
      if (u.endsWith("/v3/payments") && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            id: "pay_9",
            status: "PENDING",
            value: 79.9,
            billingType: "PIX",
            dueDate: diaBR(30),
            invoiceUrl: "https://asaas.test/fatura",
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ errors: [{ code: "404", description: "rota desconhecida" }] }), { status: 404 });
    }) as any;

    billing.__definirAsaasTeste({ apiKey: "teste", baseUrl: "https://asaas-fake.test", fetchImpl: fakeFetch });
    try {
      const r = await billing.gerarCobrancaPeriodo(1);
      assert.ok(r.ok, `esperava ok, veio: ${JSON.stringify(r)}`);
      if (!r.ok) return;
      assert.equal(r.paymentId, "pay_9");
      assert.equal(r.amountCents, 7990);
      assert.equal(r.invoiceUrl, "https://asaas.test/fatura");

      // cliente buscado (idempotente) antes do POST da cobranca
      const busca = chamadas.find((c) => c.url.includes("/v3/customers?"));
      assert.ok(busca, "deve buscar cliente por cpfCnpj antes de criar");

      const pag = await one<any>(`SELECT * FROM subscription_payments WHERE asaas_payment_id = 'pay_9'`);
      assert.ok(pag);
      assert.equal(pag.company_id, 1);
      assert.equal(pag.status, "pending");
      assert.equal(pag.amount_cents, 7990);
      const dias = (Date.parse(pag.period_end) - Date.parse(pag.period_start)) / 86400000;
      assert.equal(dias, 30);

      const sub = await one<any>(`SELECT asaas_customer_id FROM subscriptions WHERE company_id = 1`);
      assert.equal(sub.asaas_customer_id, "cus_1");
    } finally {
      billing.__definirAsaasTeste(null);
    }
  });

  it("sem asaas configurado devolve motivo claro, sem lancar", async () => {
    const { gerarCobrancaPeriodo } = await import("../src/lib/billing.ts");
    const r = await gerarCobrancaPeriodo(1);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.motivo, "asaas_nao_configurado");
  });

  it("documento invalido ou ausente recusa a cobranca com motivo claro", async () => {
    const { gerarCobrancaPeriodo, __definirAsaasTeste } = await import("../src/lib/billing.ts");
    const chamouAsaas = false;
    __definirAsaasTeste({
      apiKey: "teste",
      baseUrl: "https://asaas-fake.test",
      fetchImpl: (async () => {
        throw new Error("nao deveria chamar o Asaas com documento invalido");
      }) as any,
    });
    try {
      // Fixture usa 11111111111 (todos iguais = inválido).
      await run(`UPDATE companies SET document = '11111111111' WHERE id = 1`);
      let r = await gerarCobrancaPeriodo(1);
      assert.equal(r.ok, false);
      if (!r.ok) assert.equal(r.motivo, "documento_invalido");

      // Sem documento em companies nem company_doc nas settings.
      await run(`UPDATE companies SET document = NULL WHERE id = 1`);
      r = await gerarCobrancaPeriodo(1);
      assert.equal(r.ok, false);
      if (!r.ok) assert.equal(r.motivo, "documento_invalido");
      assert.equal(chamouAsaas, false);
    } finally {
      __definirAsaasTeste(null);
    }
  });

  it("documento valido nas settings (company_doc) cobre companies.document vazio", async () => {
    const { gerarCobrancaPeriodo, __definirAsaasTeste } = await import("../src/lib/billing.ts");
    let cpfEnviado: string | null = null;
    __definirAsaasTeste({
      apiKey: "teste",
      baseUrl: "https://asaas-fake.test",
      fetchImpl: (async (url: any, init: any) => {
        const u = String(url);
        if (u.includes("/v3/customers?") && init?.method === "GET") {
          return new Response(JSON.stringify({ data: [] }), { status: 200 });
        }
        if (u.endsWith("/v3/customers") && init?.method === "POST") {
          const corpo = JSON.parse(init.body);
          cpfEnviado = corpo.cpfCnpj;
          return new Response(JSON.stringify({ id: "cus_2", name: corpo.name, cpfCnpj: corpo.cpfCnpj }), { status: 200 });
        }
        if (u.endsWith("/v3/payments") && init?.method === "POST") {
          return new Response(
            JSON.stringify({ id: "pay_10", status: "PENDING", billingType: "PIX", dueDate: diaBR(30), invoiceUrl: "https://asaas.test/f2" }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ errors: [{ code: "404", description: "rota desconhecida" }] }), { status: 404 });
      }) as any,
    });
    try {
      await run(`UPDATE companies SET document = NULL WHERE id = 1`);
      await run(
        `INSERT INTO company_settings (company_id, key, value) VALUES (1, 'company_doc', '11144477735')
         ON CONFLICT(company_id, key) DO UPDATE SET value = excluded.value`,
      );
      const r = await gerarCobrancaPeriodo(1);
      assert.ok(r.ok, `esperava ok, veio: ${JSON.stringify(r)}`);
      assert.equal(cpfEnviado, "11144477735");
    } finally {
      __definirAsaasTeste(null);
    }
  });

  it("status do asaas mapeia para status locais corretamente", async () => {
    const { processarEventoPayment } = await import("../src/lib/billing.ts");
    const sub = await assinaturaAtiva();
    await run(
      `INSERT INTO subscription_payments (company_id, subscription_id, asaas_payment_id, amount_cents, status, due_date)
       VALUES (1, ?, 'pay_x', 7990, 'pending', '2026-10-01')`,
      [sub.id],
    );
    await processarEventoPayment("PAYMENT_OVERDUE", { payment: { id: "pay_x" } });
    const p = await one<any>(`SELECT status FROM subscription_payments WHERE asaas_payment_id = 'pay_x'`);
    assert.equal(p.status, "overdue");
    await processarEventoPayment("PAYMENT_REFUNDED", { payment: { id: "pay_x" } });
    const p2 = await one<any>(`SELECT status FROM subscription_payments WHERE asaas_payment_id = 'pay_x'`);
    assert.equal(p2.status, "refunded");
  });
});

describe("rotina diaria de inadimplencia", () => {
  beforeEach(cenario);

  it("periodo vencido vira past_due (sem asaas: sem cobranca, mas sem explodir)", async () => {
    const { rotinaDiariaBilling, estadoAssinatura } = await import("../src/lib/billing.ts");
    await assinaturaAtiva();
    await run(`UPDATE subscriptions SET current_period_end = ? WHERE company_id = 1`, [diaBR(-1)]);
    const r = await rotinaDiariaBilling();
    assert.equal(r.periodosVencidos, 1);
    const sub = await one<any>(`SELECT status FROM subscriptions WHERE company_id = 1`);
    assert.equal(sub.status, "past_due");
    const estado = await estadoAssinatura(1);
    assert.equal(estado.bloqueioDuro, false, "past_due dentro da tolerancia: acessivel");
  });

  it("past_due com cobranca vencida ha mais de 7 dias e suspensa", async () => {
    const { rotinaDiariaBilling, estadoAssinatura } = await import("../src/lib/billing.ts");
    await assinaturaAtiva("past_due");
    await run(
      `INSERT INTO subscription_payments (company_id, subscription_id, asaas_payment_id, amount_cents, status, due_date)
       VALUES (1, (SELECT id FROM subscriptions WHERE company_id = 1), 'pay_old', 7990, 'pending', ?)`,
      [diaBR(-10)],
    );
    const r = await rotinaDiariaBilling();
    assert.equal(r.suspensas, 1);
    const estado = await estadoAssinatura(1);
    assert.equal(estado.bloqueioDuro, true);
  });

  it("trial vencido sem pagamento e suspenso pela rotina", async () => {
    const { rotinaDiariaBilling } = await import("../src/lib/billing.ts");
    await run(
      `INSERT INTO subscriptions (company_id, plan_id, status, trial_ends_at, current_period_start, current_period_end)
       VALUES (1, 1, 'trial', ?, ?, ?)`,
      [diaBR(-2), diaBR(-2), diaBR(-2)],
    );
    const r = await rotinaDiariaBilling();
    assert.equal(r.trialsExpirados, 1);
    const sub = await one<any>(`SELECT status FROM subscriptions WHERE company_id = 1`);
    assert.equal(sub.status, "suspended");
  });
});

describe("troca de plano", () => {
  beforeEach(cenario);

  it("troca o plano e mantem a assinatura da mesma empresa", async () => {
    const { trocarPlano, assinaturaDaEmpresa } = await import("../src/lib/billing.ts");
    await assinaturaAtiva();
    const sub = await trocarPlano(1, "profissional");
    const plano = await one<any>(`SELECT slug FROM plans WHERE id = ?`, [sub.plan_id]);
    assert.equal(plano.slug, "profissional");
    const deNovo = await assinaturaDaEmpresa(1);
    assert.equal(deNovo!.id, sub.id, "continua a mesma linha (UNIQUE por empresa)");
  });

  it("recusa trocar plano de assinatura cancelada", async () => {
    const { trocarPlano } = await import("../src/lib/billing.ts");
    await assinaturaAtiva("canceled");
    await assert.rejects(() => trocarPlano(1, "profissional"), /cancelada/);
  });
});
