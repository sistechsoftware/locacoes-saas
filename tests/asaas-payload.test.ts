/**
 * Payload do Asaas (auditoria 2026-10-13) — Asaas 100% fake, sem rede e sem
 * nenhuma cobrança real:
 *
 *  1. de onde vêm os dados do PAGADOR (cadastro da empresa, não conta Resend
 *     nem digitados em algum painel);
 *  2. exatamente quais campos o Locô envia na cobrança (o beneficiário NÃO é
 *     enviado — ele vem do cadastro da conta Asaas);
 *  3. separação sandbox x produção (host da API escolhido pelo ambiente).
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "./helpers/d1.ts";
import { insert, one, run, resetCompanyCache } from "../src/lib/db.ts";

function diaBR(offset: number): string {
  return new Date(Date.now() - 3 * 3600000 + offset * 86400000).toISOString().slice(0, 10);
}

type Chamada = { url: string; method: string; body: any };

async function cenario() {
  createTestDb();
  resetCompanyCache();
  const billing = await import("../src/lib/billing.ts");
  billing.__definirAsaasTeste(null);
  const ps = await import("../src/lib/platform-settings.ts");
  ps.__definirChavePainelTeste(null);

  await run(`DELETE FROM subscription_payments`);
  await run(`DELETE FROM subscriptions`);
  await run(`DELETE FROM webhook_events`);
  await run(`DELETE FROM companies`);
  await run(
    `INSERT INTO companies (id, name, active, document, email) VALUES (1, 'Empresa Demo', 1, '11144477735', 'demo@teste.com')`,
  );
  await insert(
    `INSERT INTO users (id, name, username, password_hash, role, active, company_id) VALUES (1,'Owner','owner','x','owner',1,1)`,
  );
  await run(
    `INSERT INTO subscriptions (company_id, plan_id, status, current_period_start, current_period_end)
     VALUES (1, 1, 'active', ?, ?)`,
    [diaBR(0), diaBR(30)],
  );
}

/** Fake do Asaas: devolve lista de clientes VAZIA para forçar o POST de cadastro. */
function fakeAsaas(chamadas: Chamada[]) {
  return (async (url: any, init: any) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body) : null;
    chamadas.push({ url: u, method, body });

    if (u.includes("/v3/customers")) {
      if (method === "GET") return new Response(JSON.stringify({ data: [] }), { status: 200 });
      return new Response(JSON.stringify({ id: "cus_novo", ...body }), { status: 200 });
    }
    if (u.includes("/v3/payments?externalReference=")) {
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }
    if (u.endsWith("/v3/payments") && method === "POST") {
      return new Response(
        JSON.stringify({
          id: "pay_1",
          status: "PENDING",
          value: body?.value,
          billingType: body?.billingType ?? "UNDEFINED",
          dueDate: body?.dueDate,
          invoiceUrl: "https://asaas.test/fatura",
        }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ errors: [{ code: "404", description: "rota desconhecida" }] }), { status: 404 });
  }) as any;
}

beforeEach(cenario);

describe("dados do pagador vêm do cadastro da empresa", () => {
  it("POST /v3/customers carrega nome, documento e e-mail da empresa + vínculo company:<id>", async () => {
    const billing = await import("../src/lib/billing.ts");
    const chamadas: Chamada[] = [];
    billing.__definirAsaasTeste({ apiKey: "teste", baseUrl: "https://asaas-fake.test", fetchImpl: fakeAsaas(chamadas) });

    const r = await billing.gerarCobrancaPeriodo(1);
    assert.ok(r.ok, JSON.stringify(r));

    const post = chamadas.find((c) => c.method === "POST" && c.url.endsWith("/v3/customers"));
    assert.ok(post, "deve cadastrar o cliente no Asaas");
    assert.equal(post!.body.name, "Empresa Demo", "pagador = nome da empresa no cadastro");
    assert.equal(post!.body.cpfCnpj, "11144477735", "documento do cadastro, só dígitos");
    assert.equal(post!.body.email, "demo@teste.com", "e-mail do cadastro");
    assert.equal(post!.body.externalReference, "company:1", "vínculo por empresa (não por documento)");
  });

  it("quando o cliente Asaas já existe, o Locô NÃO recadastra (busca por vínculo/documento)", async () => {
    const billing = await import("../src/lib/billing.ts");
    const chamadas: Chamada[] = [];
    const fetch = (async (url: any, init: any) => {
      const u = String(url);
      chamadas.push({ url: u, method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body) : null });
      if (u.includes("/v3/customers"))
        return new Response(JSON.stringify({ data: [{ id: "cus_1", name: "Empresa Demo", cpfCnpj: "11144477735" }] }), {
          status: 200,
        });
      if (u.includes("/v3/payments?externalReference=")) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      if (u.endsWith("/v3/payments"))
        return new Response(
          JSON.stringify({ id: "pay_2", status: "PENDING", value: 79.9, billingType: "PIX", dueDate: diaBR(30) }),
          { status: 200 },
        );
      return new Response(JSON.stringify({ errors: [{ code: "404", description: "x" }] }), { status: 404 });
    }) as any;
    billing.__definirAsaasTeste({ apiKey: "teste", baseUrl: "https://asaas-fake.test", fetchImpl: fetch });

    const r = await billing.gerarCobrancaPeriodo(1);
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(chamadas.filter((c) => c.method === "POST" && c.url.endsWith("/v3/customers")).length, 0);
  });
});

describe("payload da cobrança", () => {
  it("envia cliente, valor em reais, vencimento, descrição e referência — e NADA de beneficiário", async () => {
    const billing = await import("../src/lib/billing.ts");
    const chamadas: Chamada[] = [];
    billing.__definirAsaasTeste({ apiKey: "teste", baseUrl: "https://asaas-fake.test", fetchImpl: fakeAsaas(chamadas) });

    const r = await billing.gerarCobrancaPeriodo(1, { meio: "PIX" });
    assert.ok(r.ok, JSON.stringify(r));
    if (!r.ok) return;

    const post = chamadas.find((c) => c.method === "POST" && c.url.endsWith("/v3/payments"));
    assert.ok(post, "cobrança criada via POST /v3/payments");

    const plano = await one<any>(`SELECT name, price_cents FROM plans WHERE id = 1`);
    const sub = await one<any>(`SELECT id FROM subscriptions WHERE company_id = 1`);

    // Campos que efetivamente saem daqui (é a lista COMPLETA enviada).
    assert.deepEqual(
      Object.keys(post!.body).sort(),
      ["billingType", "customer", "description", "dueDate", "externalReference", "value"],
      "nenhum campo de beneficiário/cartão é enviado pelo Locô",
    );
    assert.equal(post!.body.customer, "cus_novo");
    assert.equal(post!.body.billingType, "PIX");
    assert.equal(post!.body.value, plano.price_cents / 100, "valor vem do plano, em reais");
    assert.match(post!.body.dueDate, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(
      post!.body.description,
      `Assinatura ${plano.name} — Empresa Demo`,
      "descrição exibida na cobrança identifica plano + empresa",
    );
    assert.match(
      post!.body.externalReference,
      new RegExp(`^subscription:${sub.id}:\\d{4}-\\d{2}-\\d{2}$`),
      "idempotência por período (subscription:<assinatura>:<início do período>)",
    );

    // O beneficiário (quem recebe) NÃO é informado aqui: vem da conta Asaas.
    const proibidos = ["wallet", "beneficiary", "pixKey", "authorizedPaymentNotification"];
    for (const campo of proibidos) assert.ok(!(campo in post!.body), `campo ${campo} não deve ser enviado`);
  });
});

describe("separação sandbox x produção", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("host da API segue o ambiente configurado (sandbox x produção), nunca o contrário", async () => {
    const billing = await import("../src/lib/billing.ts");
    const ps = await import("../src/lib/platform-settings.ts");
    const { ASAAS_PRODUCAO, ASAAS_SANDBOX } = await import("../src/lib/asaas.ts");

    // Credenciais via painel (mesmo caminho de produção, onde não há secret
    // ASAAS_* no Worker): chave cifrada com PAINEL_CHAVE de teste.
    ps.__definirChavePainelTeste("chave-de-teste");
    await ps.gravarConfig("asaas_api_key", "k_de_teste");
    await run(`UPDATE subscriptions SET asaas_customer_id = 'cus_1' WHERE company_id = 1`);

    const urls: string[] = [];
    let seq = 0;
    globalThis.fetch = (async (url: any, init: any) => {
      const u = String(url);
      urls.push(u);
      if (u.includes("/v3/payments?externalReference=")) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      if (u.endsWith("/v3/payments"))
        return new Response(
          JSON.stringify({ id: `pay_${++seq}`, status: "PENDING", value: 79.9, billingType: "PIX", dueDate: diaBR(30) }),
          { status: 200 },
        );
      return new Response(JSON.stringify({ errors: [{ code: "404", description: "x" }] }), { status: 404 });
    }) as any;

    try {
      await ps.gravarConfig("asaas_environment", "sandbox");
      const sandbox = await billing.gerarCobrancaPeriodo(1);
      assert.ok(sandbox.ok, JSON.stringify(sandbox));
      assert.ok(urls.every((u) => u.startsWith(`${ASAAS_SANDBOX}/`)), `sandbox deve bater em api-sandbox: ${urls.join()}`);
      assert.equal(urls.filter((u) => u.startsWith(`${ASAAS_PRODUCAO}/`)).length, 0, "sandbox nunca chama a API de produção");
      urls.length = 0;

      // Nova cobrança (período diferente) com o ambiente trocado para produção.
      await run(`UPDATE subscriptions SET current_period_start = ?, current_period_end = ? WHERE company_id = 1`, [
        diaBR(30),
        diaBR(60),
      ]);
      await ps.gravarConfig("asaas_environment", "production");
      const producao = await billing.gerarCobrancaPeriodo(1);
      assert.ok(producao.ok, JSON.stringify(producao));
      assert.ok(urls.length > 0, "produção fez chamadas");
      assert.ok(
        urls.every((u) => u.startsWith(`${ASAAS_PRODUCAO}/`)),
        `produção deve bater em api.asaas.com: ${urls.join()}`,
      );
    } finally {
      ps.__definirChavePainelTeste(null);
    }
  });

  it("sem chave em nenhuma fonte: cobrança desativada (nao_configurado), sem chamada de rede", async () => {
    const billing = await import("../src/lib/billing.ts");
    const ps = await import("../src/lib/platform-settings.ts");
    ps.__definirChavePainelTeste("chave-de-teste"); // painel legível, mas SEM credencial gravada

    let chamadas = 0;
    globalThis.fetch = (async () => {
      chamadas++;
      return new Response("{}", { status: 200 });
    }) as any;

    const r = await billing.gerarCobrancaPeriodo(1);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.motivo, "asaas_nao_configurado");
    assert.equal(chamadas, 0, "sem credencial não se fala com a API");
  });
});
