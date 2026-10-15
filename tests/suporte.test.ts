/**
 * SUPORTE — portas, matriz de prioridade, tenant, papéis e fluxo.
 *
 * Prova, em camadas (mesmo desenho dos testes de planos):
 *
 *  1. PORTA FUNDAMENTAL (Opção A do relatório): /suporte e /api/suporte não
 *     estão em recursoDoCaminho/recursoDaApi, o módulo não entra em
 *     RECURSO_DO_MODULO — Essencial e Profissional ABREM chamado (nenhuma
 *     limitação comercial fora da oferta), e o menu mostra o item para todos;
 *  2. PRIORIDADE = MATRIZ: a prioridade da fila sai de
 *     recurLiberado(company, 'suporte') — Empresarial nasce prioritário e uma
 *     empresa Essencial com liberação administrativa SOBE na hora. Nenhuma
 *     comparação de slug fora de planos.ts (guarda estática);
 *  3. PAPIÉS: viewer só lê; operacional/financeiro abrem e respondem;
 *  4. TENANT: empresa não lê/não responde chamado alheio; sem platform_admin o
 *     lado 'suporte' não existe;
 *  5. FLUXO: abertura -> resposta da plataforma (SLA 1ª resposta + status) ->
 *     fechar/reabrir, com notificação na central, entrega de push pendente,
 *     e-mail fail-open e audit_logs nas duas pontas;
 *  6. FILA /saas: ordena prioridade ao vivo (não o priority gravado).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/* ------------------------------------------------------------------ */
/* Scaffold do Next (mesmo padrão de tests/planos-recursos.test.ts)    */
/* ------------------------------------------------------------------ */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const carregarOriginal = (Module as any)._load;

let sessaoAtual = "";

(Module as any)._load = function (request: string) {
  if (request === "next/headers") {
    return {
      cookies: async () => ({
        get: (nome: string) => (nome === "limas_session" && sessaoAtual ? { value: sessaoAtual } : undefined),
        set: () => {},
        delete: () => {},
      }),
      headers: async () => new Map(),
    };
  }
  if (request === "next/navigation") {
    return {
      redirect: (url: string) => {
        throw new Error("NEXT_REDIRECT:" + url);
      },
      notFound: () => {
        throw new Error("NEXT_NOT_FOUND");
      },
      useRouter: () => ({ push() {}, replace() {}, prefetch() {} }),
      usePathname: () => "/",
      useSearchParams: () => new URLSearchParams(),
    };
  }
  if (request === "next/cache") return { revalidatePath: () => {}, revalidateTag: () => {} };
  if (request === "next/link" || request === "next/form" || request === "next/image") {
    return { __esModule: true, default: (p: any) => p?.children ?? null, Link: (p: any) => p?.children ?? null };
  }
  if (request === "server-only") return {};
  return carregarOriginal.apply(this, arguments as any);
};

const carregar = (rel: string) => import(pathToFileURL(path.resolve(ROOT, rel)).href);

const ehRedirect = (e: any, prefixo?: string) =>
  String(e?.message ?? "").startsWith("NEXT_REDIRECT:") && (!prefixo || e.message.startsWith("NEXT_REDIRECT:" + prefixo));

async function erroDe(fn: () => Promise<unknown>): Promise<any | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    return e;
  }
}

/* ------------------------------------------------------------------ */
/* Cenário: 3 planos + operador da plataforma                          */
/* ------------------------------------------------------------------ */

const FUTURO = new Date(Date.now() + 864e5).toISOString();
const HOJE = new Date().toISOString().slice(0, 10);
const SESSAO = {
  donoEss: "sess-suporte-dono-ess",
  operEss: "sess-suporte-oper-ess",
  viewerEss: "sess-suporte-viewer-ess",
  donoProf: "sess-suporte-dono-prof",
  donoEmp: "sess-suporte-dono-emp",
  plat: "sess-suporte-plat",
};

let db: typeof import("../src/lib/db.ts");
let planos: typeof import("../src/lib/planos.ts");
let auth: typeof import("../src/lib/auth.ts");
let roles: typeof import("../src/lib/roles.ts");
let nav: typeof import("../src/lib/nav.ts");
let suporte: typeof import("../src/lib/suporte.ts");
let email: typeof import("../src/lib/email.ts");

const ator = (id: number, company_id: number, role: string, name = "Ator", platform_admin = 0) =>
  ({ id, name, company_id, role: role as any, platform_admin }) as any;

/** Chamado de apoio: ids capturados pelos testes em ordem. */
let chamadoEss = 0;
let chamadoProf = 0;
let chamadoEmp = 0;

before(async () => {
  const { createTestDb } = await import("./helpers/d1.ts");
  createTestDb();
  db = await import("../src/lib/db.ts");
  db.resetCompanyCache();

  // Empresas 2, 3 e 4 (a 1 já nasce no seed da 0027).
  await db.run(
    `INSERT INTO companies (id, name, active, email) VALUES
      (2, 'Profissional SA', 1, 'profissional@teste'),
      (3, 'Empresarial SA', 1, 'empresarial@teste'),
      (4, 'Plat SA', 1, 'plat@teste')`,
  );

  const planId = async (slug: string) =>
    (await db.scalar<number>(`SELECT id FROM plans WHERE slug = ?`, [slug]))!;
  for (const [empresa, slug] of [
    [1, "essencial"],
    [2, "profissional"],
    [3, "empresarial"],
    [4, "essencial"],
  ] as const) {
    await db.run(
      `INSERT INTO subscriptions (company_id, plan_id, status, trial_ends_at, current_period_start, current_period_end)
       VALUES (?,?, 'trial', ?, ?, ?)`,
      [empresa, await planId(slug), FUTURO.slice(0, 10), HOJE, FUTURO.slice(0, 10)],
    );
  }

  await db.run(
    `INSERT INTO users (id, name, username, password_hash, role, company_id, active, platform_admin, email) VALUES
      (81, 'Dono Essencial',   'suporte-dono-ess',  'x', 'owner',        1, 1, 0, 'donoess@teste'),
      (82, 'Oper Essencial',   'suporte-oper-ess',  'x', 'operacional',  1, 1, 0, NULL),
      (85, 'Viewer Essencial', 'suporte-viewer-ess','x', 'viewer',       1, 1, 0, NULL),
      (91, 'Dono Profissional', 'suporte-dono-prof', 'x', 'owner',        2, 1, 0, 'donoprof@teste'),
      (93, 'Dono Empresarial', 'suporte-dono-emp',  'x', 'owner',        3, 1, 0, 'donoemp@teste'),
      (84, 'Plat',             'suporte-plat',      'x', 'owner',        4, 1, 1, 'plat@teste')`,
  );
  for (const [id, sessao] of [
    [81, SESSAO.donoEss],
    [82, SESSAO.operEss],
    [85, SESSAO.viewerEss],
    [91, SESSAO.donoProf],
    [93, SESSAO.donoEmp],
    [84, SESSAO.plat],
  ] as const) {
    await db.run(`INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)`, [sessao, id, FUTURO]);
  }

  planos = await import("../src/lib/planos.ts");
  auth = await import("../src/lib/auth.ts");
  roles = await import("../src/lib/roles.ts");
  nav = await import("../src/lib/nav.ts");
  suporte = await import("../src/lib/suporte.ts");
  email = await import("../src/lib/email.ts");

  // E-mail gravado em memória (fetch falso — nada sai da máquina).
  email.__definirEmailTeste({
    apiKey: "test",
    from: "suporte@teste.dev",
    fetchImpl: (async () => new Response("{}", { status: 200 })) as any,
  });
});

after(() => {
  email.__definirEmailTeste(null);
});

/* ------------------------------------------------------------------ */
/* 1. PORTA FUNDAMENTAL — os demais planos TÊM suporte                 */
/* ------------------------------------------------------------------ */

describe("1) porta fundamental: todo plano abre chamado", () => {
  it("/suporte e /api/suporte não são recursos pagos (Opção A travada)", () => {
    assert.equal(planos.recursoDoCaminho("/suporte"), null, "/suporte entrou na matriz como pago");
    assert.equal(planos.recursoDoCaminho("/suporte/1"), null);
    assert.equal(planos.recursoDaApi("/api/suporte/arquivo/abc"), null, "/api/suporte entrou na matriz como pago");
    // O recurso PAGO continua sendo o NÍVEL prioritário, mínimo empresarial.
    assert.equal(planos.RECURSOS.suporte.minimo, "empresarial");
    assert.equal(planos.RECURSOS.suporte.fundamental, false);
  });

  it("o módulo não foi registrado como item pago em RECURSO_DO_MODULO", () => {
    const fonte = fs.readFileSync(path.join(ROOT, "src/lib/plano-gate.ts"), "utf8");
    assert.ok(!/suporte:\s*"/.test(fonte), "suporte entrou em RECURSO_DO_MODULO — a porta fecharia para os demais planos");
  });

  it("menu da empresa e menu /saas incluem Suporte; visível para Essencial", () => {
    assert.ok(nav.NAV.some((n) => n.href === "/suporte"), "item /suporte fora do NAV");
    assert.ok(nav.SAAS_NAV.some((n) => n.href === "/saas/suporte"), "item /saas/suporte fora do SAAS_NAV");
    assert.equal(planos.visivelParaPlano("/suporte", "essencial"), true, "menu escondeu Suporte do Essencial");
    assert.equal(planos.visivelParaPlano("/suporte", "profissional"), true);
    const visiveis = nav.itensParaPlano(nav.NAV, "essencial");
    assert.ok(visiveis.some((n) => n.href === "/suporte"), "itensParaPlano filtrou Suporte no Essencial");
  });

  it("requireModule('suporte') passa para o Essencial (sem /plano-restrito) e para o viewer", async () => {
    sessaoAtual = SESSAO.donoEss;
    const ctx = await auth.requireModule("suporte");
    assert.equal(ctx.user.company_id, 1);

    sessaoAtual = SESSAO.viewerEss;
    const ctxViewer = await auth.requireModule("suporte");
    assert.equal(ctxViewer.user.role, "viewer");
  });

  it("papéis: todo papel VÊ; viewer NÃO escreve; demais abrem e respondem", () => {
    for (const r of ["owner", "admin", "operacional", "financeiro", "viewer"] as const) {
      assert.equal(roles.canView(r, "suporte"), true, `${r} deveria ver suporte`);
    }
    assert.equal(roles.canEdit("viewer", "suporte"), false, "viewer não pode escrever em suporte");
    for (const r of ["owner", "admin", "operacional", "financeiro"] as const) {
      assert.equal(roles.canEdit(r, "suporte"), true, `${r} deveria poder responder`);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 2. ABERTURA + PRIORIDADE PELA MATRIZ                                 */
/* ------------------------------------------------------------------ */

describe("2) abertura e prioridade derivada da matriz", () => {
  it("a action de abertura exige papel (viewer é recusado) e o operacional abre", async () => {
    const acoes = await carregar("src/app/(app)/suporte/actions.ts");

    const fdViewer = new FormData();
    fdViewer.set("categoria", "duvida");
    fdViewer.set("assunto", "Viewer não deveria abrir");
    fdViewer.set("descricao", "Tentativa de abertura pelo papel viewer.");
    sessaoAtual = SESSAO.viewerEss;
    const negado = await erroDe(() => acoes.abrirChamadoAction(fdViewer));
    assert.ok(negado, "viewer conseguiu abrir chamado");
    assert.equal(negado.name, "PermissionError", `erro inesperado: ${negado?.message}`);

    const fd = new FormData();
    fd.set("categoria", "erro");
    fd.set("assunto", "Reserva não abre a ficha");
    fd.set("descricao", "Ao clicar na reserva 123 a tela fica branca no navegador do balcão.");
    sessaoAtual = SESSAO.donoEss;
    const e = await erroDe(() => acoes.abrirChamadoAction(fd));
    assert.ok(ehRedirect(e, "/suporte/"), `esperava redirect para o chamado, veio: ${e?.message}`);
    chamadoEss = Number(e.message.split("/suporte/")[1]);
    assert.ok(chamadoEss > 0, "id do chamado inválido");
  });

  it("Essencial nasce 'normal' e Empresarial 'prioritario' (plano congelado na abertura)", async () => {
    const tEss = await suporte.chamadoDaEmpresa(chamadoEss, 1);
    assert.ok(tEss, "chamado da empresa 1 não encontrado");
    assert.equal(tEss.priority, "normal", "Essencial não deveria nascer prioritário");
    assert.equal(tEss.plano_abertura, "essencial");
    assert.equal(tEss.status, "aberto");

    const idEmp = await suporte.abrirChamado(ator(93, 3, "owner", "Dono Empresarial"), {
      categoria: "cobranca",
      assunto: "Dúvida sobre 30 usuários",
      descricao: "Como adiciono o trigésimo usuário da equipe?",
    });
    chamadoEmp = idEmp;
    const tEmp = await suporte.chamadoDaEmpresa(idEmp, 3);
    assert.equal(tEmp?.priority, "prioritario", "Empresarial não nasceu prioritário");
    assert.equal(tEmp?.plano_abertura, "empresarial");
  });

  it("liberação administrativa muda a prioridade AO VIVO sem trocar plano", async () => {
    assert.equal(await suporte.prioridadeDaEmpresa(1), "normal");
    await db.run(
      `INSERT INTO company_feature_overrides (company_id, feature, effect, reason, created_by)
       VALUES (1, 'suporte', 'allow', 'cortesia de atendimento', 84)`,
    );
    assert.equal(
      await suporte.prioridadeDaEmpresa(1),
      "prioritario",
      "liberação admin não promoveu a prioridade da fila",
    );
    // Volta ao padrão para os próximos testes.
    await db.run(`DELETE FROM company_feature_overrides WHERE company_id = 1 AND feature = 'suporte'`);
    assert.equal(await suporte.prioridadeDaEmpresa(1), "normal");
  });

  it("guarda estática: nenhuma comparação de slug de plano em suporte.ts", () => {
    const fonte = fs.readFileSync(path.join(ROOT, "src/lib/suporte.ts"), "utf8");
    assert.ok(!/===\s*["']empresarial["']/.test(fonte), "suporte.ts comparou slug 'empresarial'");
    assert.ok(!/plano\s*===/.test(fonte), "suporte.ts comparou plano diretamente");
    assert.ok(fonte.includes("prioridadeDaEmpresa"), "prioridade não sai da matriz");
  });
});

/* ------------------------------------------------------------------ */
/* 3. TENANT                                                           */
/* ------------------------------------------------------------------ */

describe("3) isolamento multi-tenant", () => {
  it("empresa 2 não enxerga nem responde o chamado da empresa 1", async () => {
    assert.equal(await suporte.chamadoDaEmpresa(chamadoEss, 2), null, "chamado alheio vazou");

    const negado = await erroDe(() =>
      suporte.responderChamado(ator(91, 2, "owner", "Dono Prof"), {
        ticketId: chamadoEss,
        lado: "empresa",
        texto: "Mensagem indesejada.",
      }),
    );
    assert.ok(negado, "empresa 2 respondeu chamado da empresa 1");
    assert.match(negado.message, /não encontrado/i);

    const fechado = await erroDe(() => suporte.fecharChamado(ator(91, 2, "owner"), chamadoEss));
    assert.ok(fechado, "empresa 2 fechou chamado alheio");

    const lista = await suporte.listarChamados(2);
    assert.ok(!lista.some((c) => c.id === chamadoEss), "chamado da empresa 1 apareceu na lista da empresa 2");
  });

  it("sem platform_admin não existe lado 'suporte' nem status de plataforma", async () => {
    const negado = await erroDe(() =>
      suporte.responderChamado(ator(81, 1, "owner", "Dono Essencial"), {
        ticketId: chamadoEss,
        lado: "suporte",
        texto: "Fingindo ser o suporte.",
      }),
    );
    assert.ok(negado, "usuário comum respondeu como se fosse o suporte");

    const status = await erroDe(() =>
      suporte.definirStatusPlataforma(ator(81, 1, "owner"), chamadoEss, "resolvido"),
    );
    assert.ok(status, "usuário comum mudou status pela ótica da plataforma");
    assert.match(status.message, /não encontrado/i);
  });
});

/* ------------------------------------------------------------------ */
/* 4. FLUXO: resposta, SLA, notificações, e-mail, status               */
/* ------------------------------------------------------------------ */

describe("4) fluxo de atendimento", () => {
  it("resposta da plataforma: status em_andamento, 1ª resposta registrada e notifica a empresa", async () => {
    // Dispositivo push do dono — a entrega pendente nasce junto com a notificação.
    await db.run(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, label, enabled, company_id)
       VALUES (81, 'https://fcm.googleapis.com/test/suporte', 'key', 'auth', 'Device', 1, 1)`,
    );

    const acoes = await carregar("src/app/(saas)/saas/suporte/actions.ts");
    const fd = new FormData();
    fd.set("chamado", String(chamadoEss));
    fd.set("texto", "Já reproduzimos aqui: é um cache do navegador. Limpar resolve; correção sai na próxima versão.");
    sessaoAtual = SESSAO.plat;
    const e = await erroDe(() => acoes.responderSuportePlataformaAction(fd));
    assert.ok(ehRedirect(e, `/saas/suporte/${chamadoEss}`), `esperava redirect da fila, veio: ${e?.message}`);

    const t = await suporte.chamadoDaEmpresa(chamadoEss, 1);
    assert.equal(t?.status, "em_andamento");
    assert.ok(t?.first_response_at, "1ª resposta do suporte não registrada (SLA)");

    const notif = await db.one<{ company_id: number; link: string; title: string }>(
      `SELECT company_id, link, title FROM user_notifications WHERE user_id = 81 AND type = 'suporte' ORDER BY id DESC LIMIT 1`,
    );
    assert.ok(notif, "dono da empresa não foi notificado da resposta");
    assert.equal(notif.company_id, 1, "notificação gravada na empresa errada");
    assert.equal(notif.link, `/suporte/${chamadoEss}`);

    const entrega = await db.one<{ company_id: number; status: string }>(
      `SELECT d.company_id, d.status FROM push_deliveries d
         JOIN user_notifications n ON n.id = d.notification_id
        WHERE n.user_id = 81 AND n.type = 'suporte' ORDER BY d.id DESC LIMIT 1`,
    );
    assert.ok(entrega, "entrega de push não criada para a resposta");
    assert.equal(entrega.company_id, 1, "push_deliveries gravado na empresa errada");
    assert.equal(entrega.status, "pending");

    const audit = await db.one(
      `SELECT 1 FROM audit_logs WHERE entity = 'suporte' AND entity_id = ? AND action = 'responder'`,
      [chamadoEss],
    );
    assert.ok(audit, "resposta da plataforma sem audit log");
  });

  it("e-mail fail-open: o autor do chamado recebe a resposta (com RESEND de teste)", async () => {
    const antes = email.__emailsEnviados.length;
    const t = await suporte.chamadoDaEmpresa(chamadoEss, 1);
    await suporte.responderChamado(ator(84, 4, "owner", "Plat", 1), {
      ticketId: chamadoEss,
      lado: "suporte",
      texto: "Pode testar agora, por favor?",
    });
    assert.equal(email.__emailsEnviados.length, antes + 1, "e-mail de resposta não disparado");
    const msg = email.__emailsEnviados[antes];
    assert.equal(msg.to, "donoess@teste");
    assert.match(msg.subject, new RegExp(String(chamadoEss)));
    assert.ok(msg.html.includes(`/suporte/${chamadoEss}`), "e-mail sem link da conversa");
    assert.ok(t, "chamado sumiu durante o teste de e-mail");
  });

  it("reply da empresa: tira de 'aguardando' e notifica a plataforma", async () => {
    // A plataforma coloca em espera…
    await suporte.definirStatusPlataforma(ator(84, 4, "owner", "Plat", 1), chamadoEss, "aguardando_empresa");
    let t = await suporte.chamadoDaEmpresa(chamadoEss, 1);
    assert.equal(t?.status, "aguardando_empresa");

    // …e a empresa responde.
    const acoes = await carregar("src/app/(app)/suporte/actions.ts");
    const fd = new FormData();
    fd.set("chamado", String(chamadoEss));
    fd.set("texto", "Limpei o cache e voltou a funcionar, obrigado!");
    sessaoAtual = SESSAO.donoEss;
    const e = await erroDe(() => acoes.responderChamadoEmpresaAction(fd));
    assert.ok(ehRedirect(e, `/suporte/${chamadoEss}`), `esperava redirect do chamado, veio: ${e?.message}`);

    t = await suporte.chamadoDaEmpresa(chamadoEss, 1);
    assert.equal(t?.status, "em_andamento", "resposta da empresa não movimentou o status");

    const notif = await db.one<{ company_id: number; link: string }>(
      `SELECT company_id, link FROM user_notifications WHERE user_id = 84 AND type = 'suporte' ORDER BY id DESC LIMIT 1`,
    );
    assert.ok(notif, "plataforma não foi notificada da resposta da empresa");
    assert.equal(notif.link, `/saas/suporte/${chamadoEss}`);
  });

  it("fechar e reabrir pelo lado da empresa (com notificação de reabertura)", async () => {
    const acoes = await carregar("src/app/(app)/suporte/actions.ts");
    sessaoAtual = SESSAO.donoEss;

    const fdFechar = new FormData();
    fdFechar.set("chamado", String(chamadoEss));
    const eFechar = await erroDe(() => acoes.fecharChamadoAction(fdFechar));
    assert.ok(ehRedirect(eFechar, `/suporte/${chamadoEss}`));

    let t = await suporte.chamadoDaEmpresa(chamadoEss, 1);
    assert.equal(t?.status, "resolvido");
    assert.ok(t?.resolved_at, "resolved_at não gravado ao fechar");

    const fdReabrir = new FormData();
    fdReabrir.set("chamado", String(chamadoEss));
    const eReabrir = await erroDe(() => acoes.reabrirChamadoAction(fdReabrir));
    assert.ok(ehRedirect(eReabrir, `/suporte/${chamadoEss}`));

    t = await suporte.chamadoDaEmpresa(chamadoEss, 1);
    assert.equal(t?.status, "aberto");
    assert.equal(t?.resolved_at, null, "resolved_at não limpo ao reabrir");

    const audit = await db.one(
      `SELECT 1 FROM audit_logs WHERE entity = 'suporte' AND entity_id = ? AND action = 'reabrir'`,
      [chamadoEss],
    );
    assert.ok(audit, "reabertura sem audit log");
  });

  it("mensagens ficam no escopo certo e o 'visto' some das não lidas", async () => {
    const msgs = await suporte.mensagensDoChamado(chamadoEss);
    assert.ok(msgs.length >= 3, `esperava ao menos 3 mensagens, veio ${msgs.length}`);
    assert.ok(msgs.every((m) => m.company_id === 1), "mensagem gravada em outra empresa");
    assert.equal(msgs[0].author_kind, "empresa", "a primeira mensagem deveria ser a abertura");

    // Visto do lado da empresa: reseta o contador de não lidas do suporte.
    const antes = (await suporte.chamadoDaEmpresa(chamadoEss, 1))?.nao_lidas ?? 0;
    assert.ok(antes >= 1, "deveria haver mensagem não vista do suporte");
    await suporte.marcarVisto(chamadoEss, "empresa", ator(81, 1, "owner"));
    const depois = (await suporte.chamadoDaEmpresa(chamadoEss, 1))?.nao_lidas ?? 0;
    assert.equal(depois, 0, "marcarVisto não zerou as não lidas");
  });
});

/* ------------------------------------------------------------------ */
/* 5. FILA DA PLATAFORMA                                               */
/* ------------------------------------------------------------------ */

describe("5) fila /saas/suporte: prioridade ao vivo, não o priority gravado", () => {
  it("abre chamados nas três empresas e ordena Empresarial primeiro", async () => {
    chamadoProf = await suporte.abrirChamado(ator(91, 2, "owner", "Dono Prof"), {
      categoria: "duvida",
      assunto: "Como exporto relatório?",
      descricao: "Preciso exportar o relatório mensal em PDF para a contabilidade.",
    });

    const fila = await suporte.filaPlataforma({ status: "abertos" });
    assert.ok(fila.length >= 3, `fila pequena demais: ${fila.length}`);
    assert.equal(fila[0].company_id, 3, "Empresarial não ficou no topo da fila");
    assert.equal(fila[0].prioridade_viva, "prioritario");
    const posEss = fila.findIndex((c) => c.id === chamadoEss);
    const posEmp = fila.findIndex((c) => c.id === chamadoEmp);
    assert.ok(posEss > posEmp, "Essencial apareceu antes do Empresarial");
    // Empresa sem plano? aqui todas têm — mas o nome/slug vêm para exibição.
    const naFila = fila.find((c) => c.id === chamadoEmp);
    assert.equal(naFila?.company_name, "Empresarial SA");
    assert.equal(naFila?.plan_slug, "empresarial");
  });

  it("liberação administrativa reordena a fila na hora (prioridade é estado, não histórico)", async () => {
    await db.run(
      `INSERT INTO company_feature_overrides (company_id, feature, effect, reason, created_by)
       VALUES (1, 'suporte', 'allow', 'cortesia de atendimento', 84)`,
    );
    const fila = await suporte.filaPlataforma({ status: "abertos" });
    // Duas empresas prioritárias agora: a mais antiga (Essencial) lidera.
    assert.equal(fila[0].company_id, 1, "Essencial liberado não subiu para o topo");
    assert.equal(fila[0].prioridade_viva, "prioritario");
    await db.run(`DELETE FROM company_feature_overrides WHERE company_id = 1 AND feature = 'suporte'`);
  });

  it("resumo conta abertos e prioritários pela matriz", async () => {
    const r = await suporte.resumoFila();
    assert.ok(r.abertos >= 3, `resumo abertos: ${r.abertos}`);
    const fila = await suporte.filaPlataforma({ status: "abertos" });
    const esperados = fila.filter((c) => c.prioridade_viva === "prioritario").length;
    assert.equal(r.prioritarios, esperados, "resumo de prioritários divergiu da fila");
  });

  it("ação da plataforma exige platform_admin", async () => {
    const acoes = await carregar("src/app/(saas)/saas/suporte/actions.ts");
    const fd = new FormData();
    fd.set("chamado", String(chamadoEmp));
    fd.set("texto", "Resposta indevida.");
    sessaoAtual = SESSAO.donoEss; // usuário comum, sem platform_admin
    const e = await erroDe(() => acoes.responderSuportePlataformaAction(fd));
    assert.ok(e, "usuário comum passou no guard da plataforma");
    assert.equal(e.name, "PermissionError", `erro inesperado: ${e?.message}`);
    const msgs = await suporte.mensagensDoChamado(chamadoEmp);
    assert.ok(!msgs.some((m) => m.body.includes("Resposta indevida")), "mensagem indevida gravada");
  });
});

/* ------------------------------------------------------------------ */
/* 6. REGRAS DE NOTIFICAÇÃO (migration 0041 + REGRAS_PADRAO)            */
/* ------------------------------------------------------------------ */

describe("6) regra de notificação do tipo 'suporte'", () => {
  it("toda empresa existente nasce com a regra padrão do tipo (0041)", async () => {
    const regras = await db.all<{ type: string }>(
      `SELECT type FROM notification_rules WHERE company_id = 1`,
    );
    const tipos = regras.map((r) => r.type);
    assert.ok(tipos.includes("suporte"), "regra type 'suporte' ausente para a empresa 1");
    assert.ok(tipos.includes("chat"), "regras legadas sumiram");
  });

  it("REGRAS_PADRAO cobre o tipo novo (onboarding e tela de preferências andam juntos)", async () => {
    const pushRules: typeof import("../src/lib/push-rules.ts") = await carregar("src/lib/push-rules.ts");
    const tipos = pushRules.REGRAS_PADRAO.map((r) => r.type);
    assert.ok(tipos.includes("suporte"), "REGRAS_PADRAO sem o tipo 'suporte'");
    assert.deepEqual(
      [...tipos].sort(),
      Object.keys(pushRules.NOTIFICATION_TYPES).sort(),
      "REGRAS_PADRAO saiu de sincronia com os tipos da tela",
    );
    const regra = pushRules.REGRAS_PADRAO.find((r) => r.type === "suporte");
    assert.equal(regra?.enabled, 1, "regra de suporte nasce ligada");
    assert.equal(regra?.offsets, "[0]", "aviso de suporte deveria ser imediato");
  });
});
