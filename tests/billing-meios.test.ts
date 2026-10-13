/**
 * Meios de pagamento Asaas (Pix, cartão, boleto) — Fase 4.
 *
 * Tudo roda com o Asaas FAKE (gancho __definirAsaasTeste), sem rede e sem
 * nenhuma transação real. Cobre:
 *  * billingType enviado por meio (UNDEFINED padrão, PIX, BOLETO, CREDIT_CARD);
 *  * recusa de meio inválido no servidor;
 *  * fallback UNDEFINED -> PIX quando o Asaas recusa com HTTP 400;
 *  * idempotência: período já cobrado não gera segunda cobrança;
 *  * recuperação após timeout (cobrança existe no Asaas, INSERT local falhou);
 *  * dados de pagamento por modalidade (boleto/linha digitável, Pix QR);
 *  * isolamento multiempresa na consulta de dados de pagamento;
 *  * webhook: billingType fora do CHECK não quebra; evento novo não rebaixa
 *    cobrança confirmada.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "./helpers/d1.ts";
import { insert, one, run, resetCompanyCache } from "../src/lib/db.ts";

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

  await run(
    `INSERT INTO companies (id, name, active, document, email) VALUES (1, 'Empresa Demo', 1, '11144477735', 'demo@teste.com')`,
  );
  await run(`INSERT INTO companies (id, name, active, document) VALUES (2, 'Outra Empresa', 1, '22222222222')`);
  await insert(
    `INSERT INTO users (id, name, username, password_hash, role, active, company_id) VALUES (1,'Owner','owner','x','owner',1,1)`,
  );
}

type Chamada = { url: string; method: string; body: any };

/**
 * Fake do Asaas: registra as chamadas e devolve respostas configuráveis.
 * `respostasPagamentos` lista os payloads devolvidos para POST /v3/payments
 * (um por tentativa — permite simular 400 e depois 200).
 */
function fakeAsaas(opts: {
  pagamentos?: { status?: number; corpo?: any }[];
  identificationField?: any;
  pixQrCode?: any;
  pagamentosPorRef?: any[];
  falharPost?: Error;
}) {
  const chamadas: Chamada[] = [];
  let indicePost = 0;
  const fetchImpl = (async (url: any, init: any) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body) : null;
    chamadas.push({ url: u, method, body });

    if (u.includes("/v3/customers")) {
      if (method === "GET") {
        return new Response(JSON.stringify({ data: [{ id: "cus_1", name: "Empresa Demo", cpfCnpj: "11144477735" }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: "cus_novo", name: body?.name, cpfCnpj: body?.cpfCnpj }), { status: 200 });
    }
    if (u.includes("/v3/payments?externalReference=")) {
      return new Response(JSON.stringify({ data: opts.pagamentosPorRef ?? [] }), { status: 200 });
    }
    if (u.endsWith("/v3/payments") && method === "POST") {
      if (opts.falharPost) throw opts.falharPost;
      const lista = opts.pagamentos ?? [];
      const r = lista[Math.min(indicePost, lista.length - 1)] ?? {};
      indicePost++;
      return new Response(JSON.stringify(r.corpo ?? {}), { status: r.status ?? 200 });
    }
    const m = u.match(/\/v3\/payments\/([^/]+)\/identificationField$/);
    if (m) {
      if (opts.identificationField === undefined) {
        return new Response(JSON.stringify({ errors: [{ code: "404", description: "não encontrado" }] }), { status: 404 });
      }
      return new Response(JSON.stringify(opts.identificationField), { status: 200 });
    }
    const g = u.match(/\/v3\/payments\/(pay_[a-z0-9_]+)$/i);
    if (g) {
      const id = g[1];
      const tipo = id.includes("bol") ? "BOLETO" : id.includes("pix") ? "PIX" : id.includes("card") ? "CREDIT_CARD" : "UNDEFINED";
      return new Response(
        JSON.stringify({
          id,
          status: "PENDING",
          billingType: tipo,
          value: 79.9,
          dueDate: diaBR(30),
          invoiceUrl: "https://asaas.test/fatura",
          bankSlipUrl: tipo === "BOLETO" ? "https://asaas.test/boleto.pdf" : null,
        }),
        { status: 200 },
      );
    }
    const q = u.match(/\/v3\/payments\/([^/]+)\/pixQrCode$/);
    if (q) {
      if (opts.pixQrCode === undefined) {
        return new Response(JSON.stringify({ errors: [{ code: "404", description: "não encontrado" }] }), { status: 404 });
      }
      return new Response(JSON.stringify(opts.pixQrCode), { status: 200 });
    }
    return new Response(JSON.stringify({ errors: [{ code: "404", description: "rota desconhecida" }] }), { status: 404 });
  }) as any;
  return { chamadas, fetchImpl };
}

beforeEach(cenario);

describe("meio de pagamento na criação da cobrança", () => {
  it("padrão: envia billingType UNDEFINED (pagador escolhe na fatura)", async () => {
    const billing = await import("../src/lib/billing.ts");
    const fake = fakeAsaas({
      pagamentos: [{ corpo: { id: "pay_u", status: "PENDING", billingType: "UNDEFINED", value: 79.9, dueDate: diaBR(30), invoiceUrl: "https://asaas.test/f1" } }],
    });
    billing.__definirAsaasTeste({ apiKey: "teste", baseUrl: "https://asaas-fake.test", fetchImpl: fake.fetchImpl });
    try {
      const r = await billing.gerarCobrancaPeriodo(1);
      assert.ok(r.ok, `esperava ok: ${JSON.stringify(r)}`);
      const post = fake.chamadas.find((c) => c.url.endsWith("/v3/payments") && c.method === "POST");
      assert.ok(post, "deve criar cobrança no Asaas");
      assert.equal(post!.body.billingType, "UNDEFINED");
      // nada de dados de cartão no payload
      assert.equal("creditCard" in post!.body, false);
      assert.equal("creditCardHolderInfo" in post!.body, false);
      if (r.ok) assert.equal(r.billingType, "UNDEFINED");
    } finally {
      billing.__definirAsaasTeste(null);
    }
  });

  for (const [meio, esperado] of [
    ["PIX", "PIX"],
    ["BOLETO", "BOLETO"],
    ["CREDIT_CARD", "CREDIT_CARD"],
  ] as const) {
    it(`meio explícito ${meio} chega ao Asaas como billingType=${esperado}`, async () => {
      const billing = await import("../src/lib/billing.ts");
      const fake = fakeAsaas({
        pagamentos: [
          {
            corpo: {
              id: `pay_${meio}`,
              status: "PENDING",
              billingType: esperado,
              value: 79.9,
              dueDate: diaBR(30),
              invoiceUrl: "https://asaas.test/fatura",
              bankSlipUrl: esperado === "BOLETO" ? "https://asaas.test/boleto.pdf" : undefined,
            },
          },
        ],
        identificationField: esperado === "BOLETO" ? { identificationField: "34191.79001 01043.510047 91020.150008 8 98760000007990" } : undefined,
      });
      billing.__definirAsaasTeste({ apiKey: "teste", baseUrl: "https://asaas-fake.test", fetchImpl: fake.fetchImpl });
      try {
        const r = await billing.gerarCobrancaPeriodo(1, { meio });
        assert.ok(r.ok, `esperava ok: ${JSON.stringify(r)}`);
        const post = fake.chamadas.find((c) => c.url.endsWith("/v3/payments") && c.method === "POST");
        assert.equal(post!.body.billingType, esperado);
        assert.equal(post!.body.customer, "cus_1");

        const linha = await one<any>(`SELECT * FROM subscription_payments WHERE asaas_payment_id = ?`, [`pay_${meio}`]);
        assert.ok(linha, "cobrança registrada localmente");
        assert.equal(linha.billing_type, esperado);
        assert.equal(linha.status, "pending");
        assert.equal(linha.company_id, 1);

        if (r.ok) {
          assert.equal(r.billingType, esperado);
          if (esperado === "BOLETO") {
            assert.equal(r.bankSlipUrl, "https://asaas.test/boleto.pdf");
            assert.match(r.linhaDigitavel ?? "", /34191\.79001/);
          }
        }
      } finally {
        billing.__definirAsaasTeste(null);
      }
    });
  }

  it("meio inválido é recusado antes de qualquer chamada ao Asaas", async () => {
    const billing = await import("../src/lib/billing.ts");
    const fake = fakeAsaas({});
    billing.__definirAsaasTeste({ apiKey: "teste", baseUrl: "https://asaas-fake.test", fetchImpl: fake.fetchImpl });
    try {
      const r = await billing.gerarCobrancaPeriodo(1, { meio: "DINHEIRO" as any });
      assert.equal(r.ok, false);
      if (!r.ok) assert.equal(r.motivo, "meio_invalido");
      assert.equal(fake.chamadas.length, 0, "nenhuma chamada ao Asaas com meio inválido");
    } finally {
      billing.__definirAsaasTeste(null);
    }
  });

  it("fallback: Asaas recusa UNDEFINED (400) e a cobrança sai como PIX", async () => {
    const billing = await import("../src/lib/billing.ts");
    const fake = fakeAsaas({
      pagamentos: [
        { status: 400, corpo: { errors: [{ code: "8", description: "billingType inválido para esta conta" }] } },
        { corpo: { id: "pay_fb", status: "PENDING", billingType: "PIX", value: 79.9, dueDate: diaBR(30), invoiceUrl: "https://asaas.test/fb" } },
      ],
    });
    billing.__definirAsaasTeste({ apiKey: "teste", baseUrl: "https://asaas-fake.test", fetchImpl: fake.fetchImpl });
    try {
      const r = await billing.gerarCobrancaPeriodo(1);
      assert.ok(r.ok, `esperava ok com fallback: ${JSON.stringify(r)}`);
      const posts = fake.chamadas.filter((c) => c.url.endsWith("/v3/payments") && c.method === "POST");
      assert.equal(posts.length, 2, "primeira tentativa (UNDEFINED) + fallback (PIX)");
      assert.equal(posts[0].body.billingType, "UNDEFINED");
      assert.equal(posts[1].body.billingType, "PIX");
      const linha = await one<any>(`SELECT * FROM subscription_payments WHERE asaas_payment_id = 'pay_fb'`);
      assert.ok(linha, "cobrança do fallback registrada");
      assert.equal(linha.billing_type, "PIX");
    } finally {
      billing.__definirAsaasTeste(null);
    }
  });

  it("erro que NÃO é de billingType (ex.: rede) não tenta fallback", async () => {
    const billing = await import("../src/lib/billing.ts");
    const fake = fakeAsaas({ falharPost: new Error("timeout simulado") });
    billing.__definirAsaasTeste({ apiKey: "teste", baseUrl: "https://asaas-fake.test", fetchImpl: fake.fetchImpl });
    try {
      const r = await billing.gerarCobrancaPeriodo(1);
      assert.equal(r.ok, false);
      const posts = fake.chamadas.filter((c) => c.method === "POST");
      assert.equal(posts.length, 1, "sem retentativa para erro de rede");
      const n = await one<any>(`SELECT COUNT(*) AS n FROM subscription_payments`);
      assert.equal(n.n, 0, "nenhum registro local em falha de rede");
    } finally {
      billing.__definirAsaasTeste(null);
    }
  });
});

describe("idempotência — não duplicar cobrança", () => {
  it("segunda chamada para o MESMO período devolve a cobrança existente (1 POST só)", async () => {
    const billing = await import("../src/lib/billing.ts");
    const fake = fakeAsaas({
      pagamentos: [{ corpo: { id: "pay_once", status: "PENDING", billingType: "UNDEFINED", value: 79.9, dueDate: diaBR(30), invoiceUrl: "https://asaas.test/once" } }],
    });
    billing.__definirAsaasTeste({ apiKey: "teste", baseUrl: "https://asaas-fake.test", fetchImpl: fake.fetchImpl });
    try {
      const primeira = await billing.gerarCobrancaPeriodo(1);
      assert.ok(primeira.ok);
      const segunda = await billing.gerarCobrancaPeriodo(1);
      assert.ok(segunda.ok);

      const posts = fake.chamadas.filter((c) => c.url.endsWith("/v3/payments") && c.method === "POST");
      assert.equal(posts.length, 1, "só uma cobrança criada no Asaas");
      if (primeira.ok && segunda.ok) {
        assert.equal(segunda.paymentId, primeira.paymentId, "mesma cobrança devolvida");
        assert.equal(segunda.reutilizada, true, "segunda chamada reutiliza");
      }
      const n = await one<any>(`SELECT COUNT(*) AS n FROM subscription_payments`);
      assert.equal(n.n, 1, "só um registro local");
    } finally {
      billing.__definirAsaasTeste(null);
    }
  });

  it("timeout após o Asaas gravar: retentativa recupera a cobrança remota sem duplicar", async () => {
    const billing = await import("../src/lib/billing.ts");
    const vencimento = diaBR(30);

    // 1ª tentativa: POST falha (rede) — como se o Asaas tivesse gravado e a
    // resposta nunca chegasse.
    const falha = fakeAsaas({ falharPost: new Error("fetch timeout") });    billing.__definirAsaasTeste({ apiKey: "teste", baseUrl: "https://asaas-fake.test", fetchImpl: falha.fetchImpl });
    const primeira = await billing.gerarCobrancaPeriodo(1);
    assert.equal(primeira.ok, false, "primeira tentativa falha sem lançar");

    // 2ª tentativa: o Asaas devolve a cobrança criada anteriormente (mesma
    // externalReference + vencimento) — a retentativa recupera em vez de POSTar.
    const sub = await one<any>(`SELECT id, current_period_end FROM subscriptions WHERE company_id = 1`);
    const ref = `subscription:${sub.id}:${sub.current_period_end}`;
    // vencimento calculado pelo sistema: período + 30 dias (meio-dia UTC)
    const vencEsperado = new Date(Date.parse(`${sub.current_period_end}T12:00:00Z`) + 30 * 86400000)
      .toISOString()
      .slice(0, 10);
    const recupera = fakeAsaas({
      pagamentosPorRef: [
        { id: "pay_rec", status: "PENDING", billingType: "UNDEFINED", value: 79.9, dueDate: vencEsperado, externalReference: ref, invoiceUrl: "https://asaas.test/rec" },
      ],
    });
    billing.__definirAsaasTeste({ apiKey: "teste", baseUrl: "https://asaas-fake.test", fetchImpl: recupera.fetchImpl });
    try {
      const segunda = await billing.gerarCobrancaPeriodo(1);
      assert.ok(segunda.ok, `esperava recuperação: ${JSON.stringify(segunda)}`);
      const posts = recupera.chamadas.filter((c) => c.url.endsWith("/v3/payments") && c.method === "POST");
      assert.equal(posts.length, 0, "não cria nova cobrança — a existente é recuperada");
      if (segunda.ok) assert.equal(segunda.paymentId, "pay_rec");
      const linha = await one<any>(`SELECT * FROM subscription_payments WHERE asaas_payment_id = 'pay_rec'`);
      assert.ok(linha, "registro local completado");
      assert.equal(linha.status, "pending");
      const total = await one<any>(`SELECT COUNT(*) AS n FROM subscription_payments`);
      assert.equal(total.n, 1, "exatamente um registro local");
    } finally {
      billing.__definirAsaasTeste(null);
    }
  });
});

describe("dados de pagamento por modalidade", () => {
  async function semearCobranca(companyId: number, paymentId: string, billingType: string) {
    await run(
      `INSERT INTO subscriptions (company_id, plan_id, status, current_period_start, current_period_end)
       VALUES (?, 1, 'active', '2026-09-01', '2026-09-30')`,
      [companyId],
    );
    const sub = await one<any>(`SELECT id FROM subscriptions WHERE company_id = ?`, [companyId]);
    await run(
      `INSERT INTO subscription_payments (company_id, subscription_id, asaas_payment_id, amount_cents, billing_type, status, due_date)
       VALUES (?, ?, ?, 7990, ?, 'pending', '2026-10-10')`,
      [companyId, sub.id, paymentId, billingType],
    );
  }

  it("boleto devolve fatura, PDF e linha digitável", async () => {
    const billing = await import("../src/lib/billing.ts");
    await semearCobranca(1, "pay_bol", "BOLETO");
    const fake = fakeAsaas({
      identificationField: { identificationField: "34191.79001 01043.510047", barCode: "0019000000000000000" },
    });
    billing.__definirAsaasTeste({ apiKey: "teste", baseUrl: "https://asaas-fake.test", fetchImpl: fake.fetchImpl });
    try {
      const row = await one<any>(`SELECT id FROM subscription_payments WHERE asaas_payment_id = 'pay_bol'`);
      const d = await billing.dadosPagamentoCobranca(1, row.id);
      assert.ok(d, "deve devolver dados");
      assert.equal(d!.billingType, "BOLETO");
      assert.equal(d!.invoiceUrl, "https://asaas.test/fatura");
      assert.equal(d!.bankSlipUrl, "https://asaas.test/boleto.pdf");
      assert.match(d!.linhaDigitavel ?? "", /34191\.79001/);
      // consulta o pagamento no Asaas
      assert.ok(fake.chamadas.some((c) => c.url.endsWith("/v3/payments/pay_bol")));
    } finally {
      billing.__definirAsaasTeste(null);
    }
  });

  it("pix devolve QR code e copia-e-cola", async () => {
    const billing = await import("../src/lib/billing.ts");
    await semearCobranca(1, "pay_pix", "PIX");
    const fake = fakeAsaas({ pixQrCode: { encodedImage: "aGVsbG8=", payload: "00020126BR.GOV.BCB.PIX", expirationDate: "2026-11-09" } });
    billing.__definirAsaasTeste({ apiKey: "teste", baseUrl: "https://asaas-fake.test", fetchImpl: fake.fetchImpl });
    try {
      const row = await one<any>(`SELECT id FROM subscription_payments WHERE asaas_payment_id = 'pay_pix'`);
      const d = await billing.dadosPagamentoCobranca(1, row.id);
      assert.ok(d);
      assert.equal(d!.pixQrCode, "aGVsbG8=");
      assert.equal(d!.pixPayload, "00020126BR.GOV.BCB.PIX");
    } finally {
      billing.__definirAsaasTeste(null);
    }
  });

  it("isolamento: empresa 2 não consulta a cobrança da empresa 1", async () => {
    const billing = await import("../src/lib/billing.ts");
    await semearCobranca(1, "pay_iso", "PIX");
    const fake = fakeAsaas({ pixQrCode: { payload: "nao-deve-ser-acessado" } });
    billing.__definirAsaasTeste({ apiKey: "teste", baseUrl: "https://asaas-fake.test", fetchImpl: fake.fetchImpl });
    try {
      const row = await one<any>(`SELECT id FROM subscription_payments WHERE asaas_payment_id = 'pay_iso'`);
      const roubada = await billing.dadosPagamentoCobranca(2, row.id);
      assert.equal(roubada, null, "cobrança de outra empresa é invisível");
      assert.equal(
        fake.chamadas.some((c) => c.url.includes("/v3/payments/pay_iso")),
        false,
        "nem chega a consultar o Asaas",
      );
      const propria = await billing.dadosPagamentoCobranca(1, row.id);
      assert.ok(propria, "dono continua consultando normalmente");
    } finally {
      billing.__definirAsaasTeste(null);
    }
  });

  it("cobrança inexistente devolve null (sem consulta ao Asaas)", async () => {
    const billing = await import("../src/lib/billing.ts");
    const fake = fakeAsaas({});
    billing.__definirAsaasTeste({ apiKey: "teste", baseUrl: "https://asaas-fake.test", fetchImpl: fake.fetchImpl });
    try {
      assert.equal(await billing.dadosPagamentoCobranca(1, 99999), null);
      assert.equal(fake.chamadas.length, 0);
    } finally {
      billing.__definirAsaasTeste(null);
    }
  });
});

describe("webhook com os novos meios", () => {
  it("PAYMENT_CONFIRMED com billingType UNDEFINED não viola o CHECK de payment_method", async () => {
    const billing = await import("../src/lib/billing.ts");
    await run(
      `INSERT INTO subscriptions (company_id, plan_id, status, trial_ends_at, current_period_start, current_period_end)
       VALUES (1, 1, 'trial', ?, '2026-09-01', '2026-09-30')`,
      [diaBR(-1)],
    );
    const sub = await one<any>(`SELECT id FROM subscriptions WHERE company_id = 1`);
    await run(
      `INSERT INTO subscription_payments (company_id, subscription_id, asaas_payment_id, amount_cents, billing_type, status, due_date)
       VALUES (1, ?, 'pay_und', 7990, 'UNDEFINED', 'pending', ?)`,
      [sub.id, diaBR(-1)],
    );

    // O Asaas pode confirmar sem informar um meio concreto — o CHECK da
    // coluna payment_method só aceita PIX/CREDIT_CARD/BOLETO (ou NULL).
    await billing.processarEventoPayment("PAYMENT_CONFIRMED", {
      payment: { id: "pay_und", billingType: "UNDEFINED", status: "CONFIRMED" },
    });

    const atualizada = await one<any>(`SELECT status, billing_type FROM subscription_payments WHERE asaas_payment_id = 'pay_und'`);
    assert.equal(atualizada.status, "received");
    assert.equal(atualizada.billing_type, "UNDEFINED", "meio original preservado");
    const s = await one<any>(`SELECT status, payment_method FROM subscriptions WHERE id = ?`, [sub.id]);
    assert.equal(s.status, "active", "assinatura ativada apesar do meio desconhecido");
    // payment_method aceita apenas PIX/CREDIT_CARD/BOLETO (CHECK da migração 0029)
    assert.ok(
      s.payment_method === null || ["PIX", "CREDIT_CARD", "BOLETO"].includes(s.payment_method),
      `payment_method não pode ser 'UNDEFINED' (veio: ${s.payment_method})`,
    );
  });

  it("PAYMENT_CONFIRMED com billingType concreto grava payment_method válido", async () => {
    const billing = await import("../src/lib/billing.ts");
    await run(
      `INSERT INTO subscriptions (company_id, plan_id, status, current_period_start, current_period_end)
       VALUES (1, 1, 'active', '2026-09-01', '2026-09-30')`,
    );
    const sub = await one<any>(`SELECT id FROM subscriptions WHERE company_id = 1`);
    await run(
      `INSERT INTO subscription_payments (company_id, subscription_id, asaas_payment_id, amount_cents, billing_type, status, due_date)
       VALUES (1, ?, 'pay_card', 7990, 'CREDIT_CARD', 'pending', '2026-10-10')`,
      [sub.id],
    );
    await billing.processarEventoPayment("PAYMENT_CONFIRMED", {
      payment: { id: "pay_card", billingType: "CREDIT_CARD", status: "CONFIRMED" },
    });
    const s = await one<any>(`SELECT status, payment_method FROM subscriptions WHERE id = ?`, [sub.id]);
    assert.equal(s.status, "active");
    assert.equal(s.payment_method, "CREDIT_CARD");
  });

  it("evento sem status definitivo NÃO rebaixa cobrança já recebida para pending", async () => {
    const billing = await import("../src/lib/billing.ts");
    await run(
      `INSERT INTO subscriptions (company_id, plan_id, status, current_period_start, current_period_end)
       VALUES (1, 1, 'active', '2026-09-01', '2026-10-31')`,
    );
    const sub = await one<any>(`SELECT id FROM subscriptions WHERE company_id = 1`);
    await run(
      `INSERT INTO subscription_payments (company_id, subscription_id, asaas_payment_id, amount_cents, billing_type, status, due_date, paid_at)
       VALUES (1, ?, 'pay_ja', 7990, 'CREDIT_CARD', 'received', '2026-10-10', '2026-10-01 10:00:00')`,
      [sub.id],
    );

    // Evento de análise de risco de cartão (sem status definitivo): não pode
    // marcar uma cobrança recebida como pendente.
    await billing.processarEventoPayment("PAYMENT_AWAITING_RISK_ANALYSIS", {
      payment: { id: "pay_ja", billingType: "CREDIT_CARD" },
    });
    const p = await one<any>(`SELECT status, paid_at FROM subscription_payments WHERE asaas_payment_id = 'pay_ja'`);
    assert.equal(p.status, "received", "status de pagamento confirmado preservado");
    assert.equal(p.paid_at, "2026-10-01 10:00:00", "paid_at original preservado");
  });
});
