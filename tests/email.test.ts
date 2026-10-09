/**
 * E-mail transacional (Etapa 5): config por secret, envio HTTPS, fail-open e
 * templates. O gancho __definirEmailTeste injeta fetch fake — sem rede.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createTestDb, resetTestDb } from "./helpers/d1.ts";
import { resetCompanyCache } from "../src/lib/db.ts";
import {
  __definirEmailTeste,
  __definirEnvEmailTeste,
  __emailsEnviados,
  __esquecerAvisosEmail,
  emailEstado,
  enviarEmail,
  montarConfigEmail,
} from "../src/lib/email.ts";
import { ultimosErros } from "../src/lib/error-log.ts";

beforeEach(() => {
  createTestDb();
  resetCompanyCache();
  __definirEmailTeste(null);
  __definirEnvEmailTeste(null);
  __esquecerAvisosEmail();
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

describe("config do remetente (pendência #08 — sem fallback resend.dev)", () => {
  it("sem RESEND_API_KEY → sem_api_key (não envia, não quebra)", () => {
    assert.deepEqual(montarConfigEmail({}), { config: null, motivo: "sem_api_key" });
  });

  it("chave sem remetente → sem_remetente (o fallback onboarding@resend.dev saiu)", () => {
    const r = montarConfigEmail({ RESEND_API_KEY: "re_abc123" });
    assert.equal(r.motivo, "sem_remetente");
    assert.equal(r.config, null);
    // prova de que não há remetente implícito em lugar nenhum
    assert.equal(JSON.stringify(r).includes("resend.dev"), false);
  });

  it("remetente no domínio de teste resend.dev → remetente_dev (bloqueado)", () => {
    const r = montarConfigEmail({
      RESEND_API_KEY: "re_abc123",
      RESEND_FROM: "Locô <onboarding@resend.dev>",
    });
    assert.equal(r.motivo, "remetente_dev");
    assert.equal(r.config, null);
  });

  it("par completo → config com o remetente exato, sem normalizar valor", () => {
    const r = montarConfigEmail({
      RESEND_API_KEY: "re_abc123",
      RESEND_FROM: "Locô <no-reply@loco.com.br>",
    });
    assert.equal(r.motivo, null);
    assert.deepEqual(r.config, { apiKey: "re_abc123", from: "Locô <no-reply@loco.com.br>" });
  });
});

describe("config incompleta fica visível em /erros (fail-open, fail-loud)", () => {
  it("envio sem RESEND_FROM devolve false e grava UMA linha no diário", async () => {
    __definirEnvEmailTeste({ RESEND_API_KEY: "re_abc123" });
    const ok = await enviarEmail({ to: "a@b.c", subject: "s", html: "<p>x</p>" });
    assert.equal(ok, false);
    const erros = await ultimosErros("server");
    assert.equal(erros.length, 1);
    assert.match(erros[0].message, /RESEND_FROM ausente/);
    assert.equal(JSON.parse(erros[0].context).motivo, "sem_remetente");

    // dedup: nova tentativa não transforma /erros em spam
    assert.equal(await enviarEmail({ to: "a@b.c", subject: "s", html: "<p>x</p>" }), false);
    assert.equal((await ultimosErros("server")).length, 1);
  });

  it("sem contexto Cloudflare (cron) também registra — nunca falha em silêncio", async () => {
    assert.equal(await enviarEmail({ to: "a@b.c", subject: "s", html: "<p>x</p>" }), false);
    const erros = await ultimosErros("server");
    assert.equal(erros.length, 1);
    assert.match(erros[0].message, /contexto Cloudflare indisponível/);
  });

  it("emailEstado expõe o motivo para a tela /saas/configuracoes", async () => {
    __definirEnvEmailTeste({ RESEND_API_KEY: "re_abc123", RESEND_FROM: "x@resend.dev" });
    assert.equal(await emailEstado(), "remetente_dev");
    __definirEnvEmailTeste({ RESEND_API_KEY: "re_abc123", RESEND_FROM: "no-reply@loco.com.br" });
    assert.equal(await emailEstado(), "ok");
    __definirEnvEmailTeste({ RESEND_API_KEY: "re_abc123" });
    assert.equal(await emailEstado(), "sem_remetente");
    __definirEnvEmailTeste(null);
    assert.equal(await emailEstado(), "sem_contexto");
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
