/**
 * E-mail de boas-vindas (auditoria 2026-10-13):
 *
 *  1. o DESTINATÁRIO vem sempre do cadastro realizado (nunca de um endereço
 *     fixo, nem do e-mail do dono da conta Resend);
 *  2. a indisponibilidade do provedor NÃO invalida a criação da conta
 *     (fail-open: cadastro persistido, envio devolve false sem lançar);
 *  3. requisições repetidas não geram segundo cadastro — logo, não geram
 *     segundo e-mail de boas-vindas.
 *
 * Sem rede: o fetch do Resend é injetado pelo gancho __definirEmailTeste.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "./helpers/d1.ts";
import { one, resetCompanyCache, run, scalar } from "../src/lib/db.ts";
import {
  __definirEmailTeste,
  __emailsEnviados,
  __esquecerAvisosEmail,
  enviarBoasVindasCheckout,
  enviarBoasVindasSetup,
} from "../src/lib/email.ts";
import { limparEnvDoAgendador } from "../src/lib/worker-env.ts";

const APP = "https://app.locogestao.com.br";

const CADASTRO_CHECKOUT = {
  empresa: "Locadora Boas-Vindas",
  nome: "Maria Dona",
  username: "maria",
  senha: "senha-forte-1",
  plano: "essencial",
  email: "maria@locadora-bv.test",
  tipo_pessoa: "pf",
  documento: "529.982.247-25",
};

beforeEach(async () => {
  createTestDb();
  resetCompanyCache();
  __definirEmailTeste(null);
  __emailsEnviados.length = 0; // array acumulativo: limpa entre os testes
  __esquecerAvisosEmail();
  limparEnvDoAgendador();
});

/** Config fake do Resend com o domínio PRÓPRIO (nunca resend.dev). */
function resendFake(fetchImpl: (url: any, init: any) => Promise<Response>) {
  return {
    apiKey: "re_fake",
    from: "Locô — Gestão para Locações <no-reply@locogestao.com.br>",
    fetchImpl: fetchImpl as any,
  };
}

const respondeOk = async () => new Response(JSON.stringify({ id: "em_1" }), { status: 200 });
const respondeErro = async () => new Response("busy", { status: 500 });
const redeQuebra = async () => {
  throw new Error("rede indisponível");
};

describe("destinatário da boas-vindas vem do cadastro", () => {
  it("checkout: envia para o e-mail informado no cadastro, com link do app", async () => {
    const { criarEmpresaComTrial } = await import("../src/lib/onboarding.ts");
    __definirEmailTeste(resendFake(respondeOk));

    const r = await criarEmpresaComTrial(CADASTRO_CHECKOUT);
    assert.ok(r.ok, JSON.stringify(r));
    if (!r.ok) return;

    const enviado = await enviarBoasVindasCheckout(
      { nome: r.nome, empresa: r.empresa, email: r.email, trialEndsAt: r.trialEndsAt },
      APP,
    );
    assert.equal(enviado, true);
    assert.equal(__emailsEnviados.length, 1);
    assert.equal(__emailsEnviados[0].to, CADASTRO_CHECKOUT.email, "destinatário = e-mail do cadastro");
    assert.match(__emailsEnviados[0].subject, /Bem-vindo/);
    assert.match(__emailsEnviados[0].html, /Locadora Boas-Vindas/);
    assert.match(__emailsEnviados[0].html, /Maria Dona/);
    assert.match(__emailsEnviados[0].html, new RegExp(`${APP}/dashboard`));
    assert.ok(!/token=/.test(__emailsEnviados[0].html), "boas-vindas nunca carrega token");
    assert.ok(!/senha/i.test(__emailsEnviados[0].text ?? ""), "boas-vindas nunca envia senha");
  });

  it("cada cadastro recebe o SEU e-mail: segundo cliente muda o destinatário", async () => {
    const { criarEmpresaComTrial } = await import("../src/lib/onboarding.ts");
    __definirEmailTeste(resendFake(respondeOk));

    const a = await criarEmpresaComTrial(CADASTRO_CHECKOUT);
    const b = await criarEmpresaComTrial({
      ...CADASTRO_CHECKOUT,
      empresa: "Locadora Segunda",
      username: "joao",
      email: "joao@outra.test",
      documento: "11144477735",
    });
    assert.ok(a.ok && b.ok, JSON.stringify([a, b]));
    if (!a.ok || !b.ok) return;

    await enviarBoasVindasCheckout(
      { nome: a.nome, empresa: a.empresa, email: a.email, trialEndsAt: a.trialEndsAt },
      APP,
    );
    await enviarBoasVindasCheckout(
      { nome: b.nome, empresa: b.empresa, email: b.email, trialEndsAt: b.trialEndsAt },
      APP,
    );

    assert.deepEqual(
      __emailsEnviados.map((m) => m.to),
      [CADASTRO_CHECKOUT.email, "joao@outra.test"],
      "nunca um destinatário fixo: cada um recebe o próprio cadastro",
    );
  });

  it("primeiro acesso (/setup): envia para o e-mail do proprietário criado", async () => {
    const { criarPrimeiroOwner } = await import("../src/lib/primeiro-acesso.ts");
    __definirEmailTeste(resendFake(respondeOk));

    const r = await criarPrimeiroOwner({
      empresa: "Instalação Nova",
      nome: "Dono Instalação",
      username: "dono",
      senha: "senha-forte-1",
      email: "dono@instalacao.test",
      tipo_pessoa: "pj",
      documento: "11.222.333/0001-81",
    });
    assert.ok(r.ok, JSON.stringify(r));
    if (!r.ok) return;

    const enviado = await enviarBoasVindasSetup(
      { nome: r.nome, empresa: r.empresa, email: r.email },
      APP,
    );
    assert.equal(enviado, true);
    assert.equal(__emailsEnviados.length, 1);
    assert.equal(__emailsEnviados[0].to, "dono@instalacao.test");
    assert.match(__emailsEnviados[0].html, new RegExp(`${APP}/login`));
  });
});

describe("falha do Resend não invalida a criação da conta", () => {
  it("HTTP 500 na API: envio devolve false, sem lançar, e o cadastro segue íntegro", async () => {
    const { criarEmpresaComTrial } = await import("../src/lib/onboarding.ts");
    __definirEmailTeste(resendFake(respondeErro));

    const r = await criarEmpresaComTrial(CADASTRO_CHECKOUT);
    assert.ok(r.ok, JSON.stringify(r));
    if (!r.ok) return;

    const enviado = await enviarBoasVindasCheckout(
      { nome: r.nome, empresa: r.empresa, email: r.email, trialEndsAt: r.trialEndsAt },
      APP,
    );
    assert.equal(enviado, false, "provedor fora: sem promessa de entrega");

    const user = await one<any>(`SELECT id, email FROM users WHERE id = ?`, [r.userId]);
    assert.ok(user, "conta criada permanece existindo");
    assert.equal(user.email, CADASTRO_CHECKOUT.email);
    const empresa = await one<any>(`SELECT id FROM companies WHERE id = ?`, [r.companyId]);
    assert.ok(empresa, "empresa persistida");
    const sub = await one<any>(`SELECT status FROM subscriptions WHERE company_id = ?`, [r.companyId]);
    assert.equal(sub?.status, "trial", "assinatura/trial intactos");
  });

  it("queda de rede no envio: idem — false sem lançar, cadastro intacto", async () => {
    const { criarEmpresaComTrial } = await import("../src/lib/onboarding.ts");
    __definirEmailTeste(resendFake(redeQuebra));

    const r = await criarEmpresaComTrial(CADASTRO_CHECKOUT);
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(
      await enviarBoasVindasCheckout(
        { nome: r.nome, empresa: r.empresa, email: r.email, trialEndsAt: r.trialEndsAt },
        APP,
      ),
      false,
    );
    assert.equal(await scalar(`SELECT COUNT(*) FROM users WHERE company_id = ?`, [r.companyId]), 1);
  });

  it("sem configuração RESEND_* o cadastro também segue (fail-open total)", async () => {
    const { criarEmpresaComTrial } = await import("../src/lib/onboarding.ts");
    __definirEmailTeste(null); // sem chave/remetente: envio pulado, operação segue
    const r = await criarEmpresaComTrial(CADASTRO_CHECKOUT);
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(
      await enviarBoasVindasCheckout(
        { nome: r.nome, empresa: r.empresa, email: r.email, trialEndsAt: r.trialEndsAt },
        APP,
      ),
      false,
    );
    assert.equal(__emailsEnviados.length, 0);
    assert.ok(await scalar<number>(`SELECT COUNT(*) FROM users WHERE company_id = ?`, [r.companyId]));
  });
});

describe("sem duplicidade em requisições repetidas", () => {
  it("segundo envio idêntico do checkout é recusado: uma conta = um e-mail", async () => {
    const { criarEmpresaComTrial } = await import("../src/lib/onboarding.ts");
    __definirEmailTeste(resendFake(respondeOk));

    const primeiro = await criarEmpresaComTrial(CADASTRO_CHECKOUT);
    assert.ok(primeiro.ok);
    if (!primeiro.ok) return;
    await enviarBoasVindasCheckout(
      { nome: primeiro.nome, empresa: primeiro.empresa, email: primeiro.email, trialEndsAt: primeiro.trialEndsAt },
      APP,
    );

    // Requisição repetida (duplo clique / retry): recusada ANTES de gravar.
    const repetido = await criarEmpresaComTrial(CADASTRO_CHECKOUT);
    assert.ok(!repetido.ok, "sem segundo cadastro com os mesmos dados");

    // A migration 0027 já traz a empresa 1 da instalação: o checkout só acrescenta 1.
    assert.equal(await scalar(`SELECT COUNT(*) FROM companies`), 2, "nenhuma segunda empresa criada");
    assert.equal(await scalar(`SELECT COUNT(*) FROM users`), 1, "um único usuário");

    // A action só dispara a boas-vindas quando o cadastro nasceu ok — logo,
    // a tentativa repetida não produziu um segundo e-mail.
    assert.equal(__emailsEnviados.length, 1, "um único e-mail de boas-vindas");
    assert.equal(__emailsEnviados[0].to, CADASTRO_CHECKOUT.email);
  });

  it("segundo /setup é recusado (instalação já configurada): nenhum e-mail extra", async () => {
    const { criarPrimeiroOwner } = await import("../src/lib/primeiro-acesso.ts");
    __definirEmailTeste(resendFake(respondeOk));
    const dados = {
      empresa: "Instalação Única",
      nome: "Dono",
      username: "dono",
      senha: "senha-forte-1",
      email: "dono@unica.test",
      tipo_pessoa: "pf",
      documento: "11144477735",
    };
    const r1 = await criarPrimeiroOwner(dados);
    assert.ok(r1.ok, JSON.stringify(r1));
    if (!r1.ok) return;
    await enviarBoasVindasSetup({ nome: r1.nome, empresa: r1.empresa, email: r1.email }, APP);

    const r2 = await criarPrimeiroOwner({ ...dados, username: "outro", email: "outro@unica.test" });
    assert.ok(!r2.ok, "instalação já possui acesso configurado");
    assert.equal(__emailsEnviados.length, 1);
    assert.equal(__emailsEnviados[0].to, "dono@unica.test");
  });
});
