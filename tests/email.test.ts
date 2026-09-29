/**
 * E-mail transacional (Etapa 5): config por secret, envio HTTPS, fail-open e
 * templates. O gancho __definirEmailTeste injeta fetch fake — sem rede.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createTestDb, resetTestDb } from "./helpers/d1.ts";
import { resetCompanyCache } from "../src/lib/db.ts";
import { __definirEmailTeste, __emailsEnviados, enviarEmail } from "../src/lib/email.ts";

beforeEach(() => {
  createTestDb();
  resetCompanyCache();
  __definirEmailTeste(null);
});

describe("envio via Resend (fetch injetável)", () => {
  it("sem config: enviarEmail devolve false e não chama rede", async () => {
    const ok = await enviarEmail({ to: "a@b.c", subject: "s", html: "<p>x</p>" });
    assert.equal(ok, false);
  });

  it("envia com Authorization Bearer e payload Resend; registra nos enviados", async () => {
    const chamadas: { url: string; init: any }[] = [];
    __definirEmailTeste({
      apiKey: "re_fake",
      from: "Lima's <no-reply@limas.test>",
      fetchImpl: (async (url: any, init: any) => {
        chamadas.push({ url: String(url), init });
        return new Response(JSON.stringify({ id: "em_1" }), { status: 200 });
      }) as any,
    });
    const ok = await enviarEmail({ to: "joao@x.com", subject: "Olá", html: "<p>corpo</p>", text: "corpo" });
    assert.equal(ok, true);
    assert.equal(chamadas.length, 1);
    assert.equal(chamadas[0].url, "https://api.resend.com/emails");
    assert.equal(chamadas[0].init.headers.Authorization, "Bearer re_fake");
    const corpo = JSON.parse(chamadas[0].init.body);
    assert.deepEqual(corpo.to, ["joao@x.com"]);
    assert.equal(corpo.from, "Lima's <no-reply@limas.test>");
    assert.equal(__emailsEnviados.length, 1);
  });

  it("erro de rede/HTTP devolve false (fail-open), sem lançar", async () => {
    __definirEmailTeste({
      apiKey: "k",
      from: "f@x.com",
      fetchImpl: (async () => {
        throw new Error("boom");
      }) as any,
    });
    assert.equal(await enviarEmail({ to: "a@b.c", subject: "s", html: "h" }), false);
    __definirEmailTeste({
      apiKey: "k",
      from: "f@x.com",
      fetchImpl: (async () => new Response("err", { status: 500 })) as any,
    });
    assert.equal(await enviarEmail({ to: "a@b.c", subject: "s", html: "h" }), false);
  });
});

describe("templates", () => {
  it("boas-vindas, trial e cobrança montam conteúdo esperado", async () => {
    const { emailBoasVindas, emailTrialExpirando, emailTrialExpirado, emailCobrancaGerada, emailPagamentoConfirmado } =
      await import("../src/lib/email.ts");
    const bem = emailBoasVindas("João", "Locadora Teste", "2026-10-13", "https://x.test");
    assert.match(bem, /Bem-vindo/);
    assert.match(bem, /Locadora Teste/);
    assert.match(bem, /13\/10\/2026/);
    assert.match(bem, /https:\/\/x\.test\/dashboard/);

    const exp = emailTrialExpirando("Locadora Teste", "2026-10-13", "https://x.test");
    assert.match(exp, /13\/10\/2026/);
    assert.match(exp, /\/faturamento/);

    assert.match(emailTrialExpirado("L", "https://x.test"), /bloqueado/);
    const cob = emailCobrancaGerada("L", "Profissional", "R$ 149,90", "2026-10-13", "https://asaas/fatura");
    assert.match(cob, /R\$ 149,90/);
    assert.match(cob, /https:\/\/asaas\/fatura/);
    const pago = emailPagamentoConfirmado("L", "Essencial", "R$ 79,90", "2026-11-12");
    assert.match(pago, /12\/11\/2026/);
  });
});
