/**
 * GESTÃO AVANÇADA DE PLANOS — personalização por empresa e cortesias
 * (migration 0039, painel /saas).
 *
 * Prova, em camadas:
 *
 *  1. MATRIZ PURA: precedência central (resolverPermissao) e estado da
 *     cortesia derivado do tempo (estadoCortesia).
 *  2. AUTORIZAÇÃO: só platform_admin gerencia; admin/operador/usuário comum
 *     de empresa cliente são recusados NO SERVIDOR; uma empresa não altera
 *     dados de outra.
 *  3. PERSONALIZAÇÃO: liberar recurso premium sem mudar plano/preço/cobrança;
 *     outra empresa do mesmo plano fica intacta; remover liberação; bloqueio
 *     individual; ausência de personalização = comportamento idêntico.
 *  4. CORTESIAS: criação válida; datas inválidas recusadas; futuro não
 *     libera; vigente libera; expirada não libera MESMO SEM CRON; cancelamento
 *     antecipado preserva a assinatura; sobreposição; plano trocado durante a
 *     cortesia; histórico preservado; nenhuma cobrança criada ou alterada.
 *  5. LIMITE DE USUÁRIOS: ajuste individual aplicado e removível.
 *  6. AUDITORIA: antes/depois gravados; responsável registrado.
 */
import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
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

/* ------------------------------------------------------------------ */
/* Cenário: 3 empresas no plano Essencial (101, 102) e 103 sem ajuste   */
/* ------------------------------------------------------------------ */

const FUTURO = new Date(Date.now() + 864e5).toISOString();
const HOJE = new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);

const SESSAO = {
  donoEss: "sess-pers-dono-ess",
  adminEss: "sess-pers-admin-ess",
  operEss: "sess-pers-oper-ess",
  viewerEss: "sess-pers-viewer-ess",
  donoBeta: "sess-pers-dono-beta",
  plat: "sess-pers-plat",
  platOutra: "sess-pers-plat-outra",
};

let db: typeof import("../src/lib/db.ts");
let gate: typeof import("../src/lib/assinatura-gate.ts");
let planos: typeof import("../src/lib/planos.ts");
let auth: typeof import("../src/lib/auth.ts");
let billing: typeof import("../src/lib/billing.ts");
let usuarios: typeof import("../src/lib/usuarios.ts");
let pers: typeof import("../src/lib/plano-personalizado.ts");
let actions: typeof import("../src/app/(saas)/saas/actions.ts");

const ehRedirect = (e: any, url?: string) =>
  String(e?.message ?? "").startsWith("NEXT_REDIRECT:") && (!url || e.message === "NEXT_REDIRECT:" + url);

async function erroDe(fn: () => Promise<unknown>): Promise<any | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    return e;
  }
}

const ator = (id: number, company_id: number, role: string, platform = false) => ({
  id,
  name: `Ator ${id}`,
  company_id,
  role: role as any,
  platform_admin: platform,
});

before(async () => {
  const { createTestDb } = await import("./helpers/d1.ts");
  createTestDb();
  db = await import("../src/lib/db.ts");
  db.resetCompanyCache();

  // Empresas 101 e 102: mesmo plano Essencial (prova de isolamento).
  // Empresa 103: Essencial também, sem nenhuma personalização (regressão).
  await db.run(
    `INSERT INTO companies (id, name, active, email) VALUES
      (101, 'Alpha Locacoes', 1, 'alpha@teste'),
      (102, 'Beta Locacoes',  1, 'beta@teste'),
      (103, 'Gamma Locacoes', 1, 'gamma@teste')`,
  );
  const essId = (await db.scalar<number>(`SELECT id FROM plans WHERE slug = 'essencial'`))!;
  const profId = (await db.scalar<number>(`SELECT id FROM plans WHERE slug = 'profissional'`))!;
  for (const [empresa, planId] of [
    [101, essId],
    [102, essId],
    [103, essId],
  ] as const) {
    await db.run(
      `INSERT INTO subscriptions (company_id, plan_id, status, trial_ends_at, current_period_start, current_period_end)
       VALUES (?,?, 'active', ?, ?, ?)`,
      [empresa, planId, FUTURO.slice(0, 10), HOJE, FUTURO.slice(0, 10)],
    );
  }
  void profId;

  await db.run(
    `INSERT INTO users (id, name, username, password_hash, role, company_id, active, platform_admin) VALUES
      (11, 'Dono Alpha',    'pers-dono-ess',  'x', 'owner',       101, 1, 0),
      (12, 'Admin Alpha',   'pers-admin-ess', 'x', 'admin',       101, 1, 0),
      (13, 'Oper Alpha',    'pers-oper-ess',  'x', 'operacional', 101, 1, 0),
      (14, 'Viewer Alpha',  'pers-view-ess',  'x', 'viewer',      101, 1, 0),
      (15, 'Dono Beta',     'pers-dono-beta', 'x', 'owner',       102, 1, 0),
      (16, 'Plataforma A',  'pers-plat',      'x', 'owner',       101, 1, 1),
      (17, 'Plataforma B',  'pers-plat-b',    'x', 'owner',       102, 1, 1)`,
  );
  for (const [id, sessao] of [
    [11, SESSAO.donoEss],
    [12, SESSAO.adminEss],
    [13, SESSAO.operEss],
    [14, SESSAO.viewerEss],
    [15, SESSAO.donoBeta],
    [16, SESSAO.plat],
    [17, SESSAO.platOutra],
  ] as const) {
    await db.run(`INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)`, [sessao, id, FUTURO]);
  }

  planos = await import("../src/lib/planos.ts");
  gate = await import("../src/lib/assinatura-gate.ts");
  auth = await import("../src/lib/auth.ts");
  billing = await import("../src/lib/billing.ts");
  usuarios = await import("../src/lib/usuarios.ts");
  pers = await import("../src/lib/plano-personalizado.ts");
  actions = await carregar("src/app/(saas)/saas/actions.ts");
});

beforeEach(() => {
  gate.resetCacheGateAssinatura();
  sessaoAtual = SESSAO.donoEss;
});

/** Cortesia montada direto no banco, com janela relativa ao "agora". */
async function inserirCortesia(
  companyId: number,
  planSlug: string,
  inicio: string,
  fim: string,
  extra: { canceled_at?: string } = {},
) {
  return await db.run(
    `INSERT INTO company_courtesies (company_id, plan_slug, starts_at, ends_at, reason, created_by_name, canceled_at)
     VALUES (?,?,?,?,?,?,?)`,
    [companyId, planSlug, inicio, fim, "teste de vigência", "Plataforma", extra.canceled_at ?? null],
  );
}

/** Momento local (YYYY-MM-DDTHH:MM) com offset em minutos. */
function localComOffset(minutos: number): string {
  return pers.normalizarMomento(new Date(Date.now() - 3 * 3600000 + minutos * 60000).toISOString());
}

/* ------------------------------------------------------------------ */
/* 1. MATRIZ PURA                                                      */
/* ------------------------------------------------------------------ */

describe("1) precedência central (resolverPermissao) e estado da cortesia", () => {
  it("bloqueio admin prevalece sobre fundamental, plano, liberação e cortesia", () => {
    for (const caso of [
      { recurso: "reservas" as const, planoInclui: true, cortesiaInclui: true },
      { recurso: "chat" as const, planoInclui: false, cortesiaInclui: true, ajuste: "allow" as const },
    ]) {
      const r = planos.resolverPermissao({ ...caso, ajuste: "block" });
      assert.equal(r.liberado, false);
      assert.equal(r.origem, "bloqueio_admin");
    }
  });

  it("sem ajuste: fundamental > plano > cortesia > não incluído", () => {
    assert.deepEqual(planos.resolverPermissao({ recurso: "reservas", planoInclui: false }), {
      liberado: true,
      origem: "fundamental",
    });
    assert.deepEqual(planos.resolverPermissao({ recurso: "chat", planoInclui: true }), {
      liberado: true,
      origem: "plano",
    });
    assert.deepEqual(planos.resolverPermissao({ recurso: "chat", planoInclui: false, cortesiaInclui: true }), {
      liberado: true,
      origem: "cortesia",
    });
    assert.deepEqual(planos.resolverPermissao({ recurso: "fretes", planoInclui: false }), {
      liberado: false,
      origem: "nao_incluido",
    });
  });

  it("liberação admin vale depois do plano não incluir, mas a origem é a exceção", () => {
    const r = planos.resolverPermissao({ recurso: "fretes", planoInclui: false, ajuste: "allow" });
    assert.deepEqual(r, { liberado: true, origem: "liberacao_admin" });
  });

  it("estado da cortesia é derivado do tempo (programada/ativa/expirada/cancelada)", () => {
    const agora = "2026-10-14T12:00";
    assert.equal(pers.estadoCortesia({ starts_at: "2026-10-15T00:00", ends_at: "2026-10-20T00:00" }, agora), "programada");
    assert.equal(pers.estadoCortesia({ starts_at: "2026-10-14T11:59", ends_at: "2026-10-14T12:01" }, agora), "ativa");
    assert.equal(pers.estadoCortesia({ starts_at: "2026-10-10T00:00", ends_at: "2026-10-13T23:59" }, agora), "expirada");
    assert.equal(
      pers.estadoCortesia({ starts_at: "2026-10-14T00:00", ends_at: "2026-10-20T00:00", canceled_at: "2026-10-14T01:00" }, agora),
      "cancelada",
    );
  });

  it("normalização de momento: aceita espaço/T e corta segundos", () => {
    assert.equal(pers.normalizarMomento("2026-10-14 09:30:15"), "2026-10-14T09:30");
    assert.equal(pers.normalizarMomento("2026-10-14T09:30"), "2026-10-14T09:30");
    assert.equal(pers.momentoValido("2026-10-14T09:30"), true);
    assert.equal(pers.momentoValido("ontem"), false);
  });
});

/* ------------------------------------------------------------------ */
/* 2. AUTORIZAÇÃO — só o administrador global da plataforma            */
/* ------------------------------------------------------------------ */

describe("2) autorização server-side das operações administrativas", () => {
  const cenarios: [string, string][] = [
    ["dono da empresa", SESSAO.donoEss],
    ["admin da empresa", SESSAO.adminEss],
    ["operador", SESSAO.operEss],
    ["viewer", SESSAO.viewerEss],
    ["dono de outra empresa", SESSAO.donoBeta],
  ];

  for (const [rotulo, sessao] of cenarios) {
    it(`${rotulo} NÃO gerencia funcionalidades/cortesias/limite (PermissionError no servidor)`, async () => {
      sessaoAtual = sessao;
      assert.equal((await erroDe(() => actions.salvarRecursosEmpresaAction(101, [{ recurso: "chat", efeito: "liberar" }], "tentativa")))?.name, "PermissionError");
      assert.equal((await erroDe(() => actions.criarCortesiaAction(101, { planSlug: "profissional", startsAt: "2026-10-14T10:00", endsAt: "2026-10-20T10:00", motivo: "tentativa" })))?.name, "PermissionError");
      assert.equal((await erroDe(() => actions.cancelarCortesiaAction(1)))?.name, "PermissionError");
      assert.equal((await erroDe(() => actions.salvarLimiteUsuariosAction(101, 50, "tentativa")))?.name, "PermissionError");
      // E nada foi gravado.
      const overrides = await db.scalar<number>(`SELECT COUNT(*) FROM company_feature_overrides WHERE company_id = 101`);
      assert.equal(overrides, 0);
      const cortesias = await db.scalar<number>(`SELECT COUNT(*) FROM company_courtesies WHERE company_id = 101`);
      assert.equal(cortesias, 0);
    });
  }

  it("o admin global consegue operar e a empresa alvo é validada no servidor", async () => {
    sessaoAtual = SESSAO.plat;
    const r = await actions.salvarRecursosEmpresaAction(101, [{ recurso: "chat", efeito: "liberar" }], "acordo comercial");
    assert.equal(r.ok, true, r.mensagem);
    // Empresa inexistente é recusada mesmo para o admin global.
    const inexistente = await actions.salvarRecursosEmpresaAction(99999, [{ recurso: "chat", efeito: "liberar" }], "x");
    assert.equal(inexistente.ok, false);
    // Recurso desconhecido é recusado (whitelist do catálogo).
    const invalido = await actions.salvarRecursosEmpresaAction(101, [{ recurso: "hackeado", efeito: "liberar" }], "x");
    assert.equal(invalido.ok, false);
  });

  it("as páginas do painel exigem platform_admin (gate no servidor)", async () => {
    sessaoAtual = SESSAO.donoEss; // usuário comum tentando abrir /saas/*
    for (const pagina of [
      "src/app/(saas)/saas/empresas/[id]/page.tsx",
      "src/app/(saas)/saas/empresas/page.tsx",
      "src/app/(saas)/saas/assinaturas/page.tsx",
    ]) {
      const mod = await carregar(pagina);
      const e = await erroDe(() => mod.default({ params: Promise.resolve({ id: "102" }) }));
      assert.ok(ehRedirect(e, "/dashboard?erro=permissao") || ehRedirect(e, "/login"), `${pagina}: ${e?.message}`);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 3. PERSONALIZAÇÃO DE FUNCIONALIDADES                                */
/* ------------------------------------------------------------------ */

describe("3) personalização: liberar/bloquear sem tocar em plano, preço ou cobrança", () => {
  it("libera recurso premium para 101 sem mudar plano, preço, período ou gerar cobrança", async () => {
    sessaoAtual = SESSAO.plat;
    const antes = (await db.one<any>(`SELECT * FROM subscriptions WHERE company_id = 101`))!;
    const pagamentosAntes = await db.scalar<number>(`SELECT COUNT(*) FROM subscription_payments WHERE company_id = 101`);

    // chat (profissional) e fretes (empresarial) liberados para o Essencial.
    const r = await actions.salvarRecursosEmpresaAction(
      101,
      [
        { recurso: "chat", efeito: "liberar" },
        { recurso: "fretes", efeito: "liberar" },
      ],
      "pacote promocional combinado",
    );
    assert.equal(r.ok, true, r.mensagem);

    sessaoAtual = SESSAO.donoEss;
    assert.ok(await auth.requireModule("chat"), "chat deve abrir após a liberação");
    assert.ok(await auth.requireModule("fretes"), "fretes devem abrir após a liberação");

    const depois = (await db.one<any>(`SELECT * FROM subscriptions WHERE company_id = 101`))!;
    assert.equal(depois.plan_id, antes.plan_id, "plano contratado não muda");
    assert.equal(depois.status, antes.status, "status da assinatura não muda");
    assert.equal(depois.current_period_end, antes.current_period_end, "vencimento não muda");
    // Preço: o do plano continua sendo o cobrado (plans.price_cents intacto
    // e a assinatura segue apontando para o mesmo plano).
    const precoDepois = await db.one<{ price_cents: number }>(
      `SELECT p.price_cents FROM plans p JOIN subscriptions s ON s.plan_id = p.id WHERE s.company_id = 101`,
    );
    assert.equal(precoDepois?.price_cents, 7990, "preço do Essencial permanece R$ 79,90");
    const pagamentosDepois = await db.scalar<number>(`SELECT COUNT(*) FROM subscription_payments WHERE company_id = 101`);
    assert.equal(pagamentosDepois, pagamentosAntes, "nenhuma cobrança foi criada");
  });

  it("a outra empresa do MESMO plano não é afetada (isolamento por company_id)", async () => {
    sessaoAtual = SESSAO.donoBeta;
    const e = await erroDe(() => auth.requireModule("chat"));
    assert.ok(ehRedirect(e, "/plano-restrito?recurso=chat"), "Beta (mesmo plano) continua barrada");
    const overrides = await db.scalar<number>(`SELECT COUNT(*) FROM company_feature_overrides WHERE company_id = 102`);
    assert.equal(overrides, 0, "nenhum override foi gravado na empresa vizinha");
  });

  it("remover a liberação devolve o comportamento do plano na hora", async () => {
    sessaoAtual = SESSAO.plat;
    const r = await actions.salvarRecursosEmpresaAction(101, [{ recurso: "chat", efeito: "auto" }], "fim do acordo");
    assert.equal(r.ok, true, r.mensagem);
    sessaoAtual = SESSAO.donoEss;
    const e = await erroDe(() => auth.requireModule("chat"));
    assert.ok(ehRedirect(e, "/plano-restrito?recurso=chat"), "sem o ajuste, vale o plano");
    // fretes (liberado no teste anterior) continua liberado — ajustes são por recurso.
    assert.ok(await auth.requireModule("fretes"));
  });

  it("bloqueio individual prevalece sobre o plano incluso", async () => {
    // 102: upgrade para profissional (inclui chat) e depois bloqueio excepcional.
    sessaoAtual = SESSAO.plat;
    await billing.trocarPlano(102, "profissional");
    gate.resetCacheGateAssinatura();
    sessaoAtual = SESSAO.donoBeta;
    assert.ok(await auth.requireModule("chat"), "profissional tem chat");

    sessaoAtual = SESSAO.plat;
    const r = await actions.salvarRecursosEmpresaAction(102, [{ recurso: "chat", efeito: "bloquear" }], "uso indevido do chat");
    assert.equal(r.ok, true, r.mensagem);
    gate.resetCacheGateAssinatura();
    sessaoAtual = SESSAO.donoBeta;
    const e = await erroDe(() => auth.requireModule("chat"));
    assert.ok(ehRedirect(e, "/plano-restrito?recurso=chat"), "bloqueio admin barra mesmo com plano incluso");
    // API do chat também barra (mesmo gate no backend).
    const rota = await carregar("src/app/api/chat/route.ts");
    const resp = await rota.GET(new Request("http://localhost/api/chat"));
    assert.equal(resp.status, 403, "API responde 403 pelo bloqueio");
    assert.equal((await resp.json()).code, "recurso_nao_contratado");

    // Libera 102 de volta para o resto do teste.
    sessaoAtual = SESSAO.plat;
    await actions.salvarRecursosEmpresaAction(102, [{ recurso: "chat", efeito: "auto" }], "regularização");
    await billing.trocarPlano(102, "essencial");
    gate.resetCacheGateAssinatura();
  });

  it("ausência de personalização mantém o comportamento original (empresa 103 intocada)", async () => {
    sessaoAtual = SESSAO.plat;
    // Nada foi feito em 103 — o gate dela é o mesmo de sempre.
    const estado = await pers.estadoRecursosEmpresa(103);
    assert.equal(estado.plano, "essencial");
    assert.equal(estado.cortesia, null);
    const chat = estado.recursos.find((r) => r.recurso === "chat")!;
    assert.equal(chat.liberado, false);
    assert.equal(chat.origem, "nao_incluido");
    const reservas = estado.recursos.find((r) => r.recurso === "reservas")!;
    assert.deepEqual([reservas.liberado, reservas.origem], [true, "fundamental"]);
  });

  it("renovação de cobrança/troca de plano NÃO apaga personalizações válidas", async () => {
    sessaoAtual = SESSAO.plat;
    await actions.salvarRecursosEmpresaAction(101, [{ recurso: "relatorios", efeito: "liberar" }], "bônus comercial");
    // Simula a renovação que o webhook faz: novo período + status active.
    const subId = (await db.scalar<number>(`SELECT id FROM subscriptions WHERE company_id = 101`))!;
    await db.run(
      `UPDATE subscriptions SET status = 'active', current_period_start = ?, current_period_end = ?,
         payment_method = 'PIX', suspended_at = NULL, updated_at = datetime('now','localtime') WHERE id = ?`,
      [HOJE, new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10), subId],
    );
    // E troca de plano ida e volta.
    await billing.trocarPlano(101, "empresarial");
    await billing.trocarPlano(101, "essencial");
    gate.resetCacheGateAssinatura();

    const ajuste = await db.one(`SELECT * FROM company_feature_overrides WHERE company_id = 101 AND feature = 'relatorios'`);
    assert.ok(ajuste, "a liberação permanente sobrevive a renovação e trocas de plano");
    sessaoAtual = SESSAO.donoEss;
    assert.ok(await auth.requireModule("relatorios"), "e continua valendo no gate");
  });
});

/* ------------------------------------------------------------------ */
/* 4. CORTESIAS                                                        */
/* ------------------------------------------------------------------ */

describe("4) cortesias: vigência derivada do tempo, sem depender de cron", () => {
  it("cria cortesia com datas válidas e NÃO toca na assinatura comercial", async () => {
    sessaoAtual = SESSAO.plat;
    const antes = (await db.one<any>(`SELECT * FROM subscriptions WHERE company_id = 103`))!;
    const inicio = localComOffset(-60); // começou há 1h
    const fim = localComOffset(60 * 24); // termina amanhã
    const r = await actions.criarCortesiaAction(103, {
      planSlug: "empresarial",
      startsAt: inicio,
      endsAt: fim,
      motivo: "compensação por indisponibilidade",
      observacoes: "autorizada pelo dono",
    });
    assert.equal(r.ok, true, r.mensagem);

    // Assinatura intocada.
    const depois = (await db.one<any>(`SELECT * FROM subscriptions WHERE company_id = 103`))!;
    assert.equal(depois.plan_id, antes.plan_id, "plano contratado permanece");
    assert.equal(depois.status, antes.status);
    assert.equal(depois.current_period_end, antes.current_period_end);
    // Nenhuma cobrança nova.
    const cobrancas = await db.scalar<number>(`SELECT COUNT(*) FROM subscription_payments WHERE company_id = 103`);
    assert.equal(cobrancas, 0);

    // Recursos do empresarial liberados pela cortesia (gate real).
    gate.resetCacheGateAssinatura();
    const estado = await pers.estadoRecursosEmpresa(103);
    assert.ok(estado.cortesia, "cortesia ativa deve aparecer");
    assert.equal(estado.cortesia!.estado, "ativa");
    for (const r2 of ["fretes", "contratos", "chat", "relatorios"] as const) {
      const linha = estado.recursos.find((x) => x.recurso === r2)!;
      assert.equal(linha.liberado, true, `${r2} deve estar liberado pela cortesia`);
      assert.equal(linha.origem, "cortesia", `${r2} tem origem na cortesia, não no plano`);
    }
  });

  it("recusa datas inválidas ou inconsistentes", async () => {
    sessaoAtual = SESSAO.plat;
    const base = { planSlug: "profissional", motivo: "teste" };
    const casos: [string, { startsAt: string; endsAt: string }][] = [
      ["término antes do início", { startsAt: "2026-10-20T10:00", endsAt: "2026-10-14T10:00" }],
      ["término igual ao início", { startsAt: "2026-10-14T10:00", endsAt: "2026-10-14T10:00" }],
      ["data lixo", { startsAt: "amanhã", endsAt: "depois" }],
      ["formato parcial", { startsAt: "14/10/2026", endsAt: "20/10/2026" }],
    ];
    for (const [rotulo, janela] of casos) {
      const r = await actions.criarCortesiaAction(103, { ...base, ...janela });
      assert.equal(r.ok, false, `${rotulo} deveria ser recusado`);
    }
    // Duração absurda (> 365 dias) também.
    const longa = await actions.criarCortesiaAction(103, {
      planSlug: "profissional",
      startsAt: "2026-10-14T10:00",
      endsAt: "2028-10-14T10:00",
      motivo: "teste duração",
    });
    assert.equal(longa.ok, false);
    // Motivo obrigatório.
    const semMotivo = await actions.criarCortesiaAction(103, {
      planSlug: "profissional",
      startsAt: "2026-10-14T10:00",
      endsAt: "2026-10-20T10:00",
      motivo: "",
    });
    assert.equal(semMotivo.ok, false);
  });

  it("cortesia FUTURA não libera nada antes da data de início", async () => {
    sessaoAtual = SESSAO.plat;
    await inserirCortesia(103, "profissional", localComOffset(60 * 24), localComOffset(60 * 48));
    gate.resetCacheGateAssinatura();
    const estado = await pers.estadoRecursosEmpresa(103);
    // A cortesia anterior (ativa, do teste 4.1) ainda cobre; criei uma futura
    // em cima — as duas coexistem sem somar período.
    const chat = estado.recursos.find((r) => r.recurso === "chat")!;
    assert.equal(chat.liberado, true);
    // A futura, isolada, não vale: checar pela lista (estado programada).
    const lista = await pers.listarCortesias(103);
    assert.ok(lista.some((c) => c.estado === "programada"), "futura fica programada, sem efeito");

    // Agora um caso limpo: 102 recebe só uma cortesia futura → nada libera.
    await inserirCortesia(102, "empresarial", localComOffset(60 * 24), localComOffset(60 * 72));
    gate.resetCacheGateAssinatura();
    const estado102 = await pers.estadoRecursosEmpresa(102);
    const fretes102 = estado102.recursos.find((r) => r.recurso === "fretes")!;
    assert.equal(fretes102.liberado, false, "futura não libera fretes para 102");
  });

  it("EXPIRAÇÃO funciona mesmo sem nenhuma rotina agendada (cron falho)", async () => {
    // Cortesia que já terminou há 1h — gravada direto, SEM rodar rotina nenhuma.
    await db.run(`DELETE FROM company_courtesies WHERE company_id = 102`);
    await inserirCortesia(102, "empresarial", localComOffset(-60 * 48), localComOffset(-60));
    gate.resetCacheGateAssinatura();
    const estado = await pers.estadoRecursosEmpresa(102);
    assert.equal(estado.cortesia, null, "expirada não aparece como ativa");
    const fretes = estado.recursos.find((r) => r.recurso === "fretes")!;
    assert.equal(fretes.liberado, false, "expirada não libera nada");
    // E o gate de página barra de novo.
    sessaoAtual = SESSAO.donoBeta;
    const e = await erroDe(() => auth.requireModule("fretes"));
    assert.ok(ehRedirect(e, "/plano-restrito?recurso=fretes"));
  });

  it("cancelar antecipadamente encerra SÓ a cortesia, preservando assinatura e histórico", async () => {
    sessaoAtual = SESSAO.plat;
    const assinaturaAntes = (await db.one<any>(`SELECT * FROM subscriptions WHERE company_id = 103`))!;
    const id = (await db.scalar<number>(`SELECT id FROM company_courtesies WHERE company_id = 103 AND canceled_at IS NULL ORDER BY id LIMIT 1`))!;
    const r = await actions.cancelarCortesiaAction(id);
    assert.equal(r.ok, true, r.mensagem);

    // Linha preservada (não apagada), marcada como cancelada.
    const linha = await db.one<any>(`SELECT * FROM company_courtesies WHERE id = ?`, [id]);
    assert.ok(linha, "o registro histórico permanece");
    assert.ok(linha.canceled_at, "marcada como cancelada");
    // Assinatura intocada.
    const assinaturaDepois = (await db.one<any>(`SELECT * FROM subscriptions WHERE company_id = 103`))!;
    assert.equal(assinaturaDepois.plan_id, assinaturaAntes.plan_id, "plano contratado preservado");
    assert.equal(assinaturaDepois.status, assinaturaAntes.status, "status preservado");
    assert.equal(assinaturaDepois.current_period_end, assinaturaAntes.current_period_end, "período preservado");
    // Benefícios daquela cortesia encerraram.
    gate.resetCacheGateAssinatura();
    const estado = await pers.estadoRecursosEmpresa(103);
    const contratos = estado.recursos.find((r) => r.recurso === "contratos")!;
    assert.equal(contratos.liberado, false, "sem cortesia válida, contratos voltam ao plano (essencial não inclui)");
  });

  it("duas cortesias sobrepostas: cada uma vale pelo seu período (união, sem soma silenciosa)", async () => {
    sessaoAtual = SESSAO.plat;
    await inserirCortesia(103, "profissional", localComOffset(-60), localComOffset(60 * 24));
    await inserirCortesia(103, "empresarial", localComOffset(-30), localComOffset(60 * 12));
    gate.resetCacheGateAssinatura();
    const estado = await pers.estadoRecursosEmpresa(103);
    // A ativa escolhida é a de término mais recente (empresarial); fretes
    // (empresarial) e chat (profissional+) ficam liberados — união dos planos
    // vigentes não reduz nada.
    const contratos = estado.recursos.find((r) => r.recurso === "contratos")!;
    assert.equal(contratos.liberado, true, "cortesia empresarial cobre contratos");
    const lista = await pers.listarCortesias(103);
    assert.ok(lista.filter((c) => c.estado === "ativa").length >= 1, "ambas ativas são listadas");
  });

  it("plano comercial trocado durante a cortesia: respeita o estado atual, não restaura o antigo", async () => {
    sessaoAtual = SESSAO.plat;
    // 102 tem cortesia expirada (teste 4.4). Trocar o plano para profissional
    // agora NÃO ressuscita a cortesia nem a antiga condição essencial.
    await billing.trocarPlano(102, "empresarial");
    gate.resetCacheGateAssinatura();
    const estado = await pers.estadoRecursosEmpresa(102);
    const fretes = estado.recursos.find((r) => r.recurso === "fretes")!;
    assert.equal([fretes.liberado, fretes.origem].join("/"), "true/plano", "libera pelo plano ATUAL, não pela cortesia");
    await billing.trocarPlano(102, "essencial");
    gate.resetCacheGateAssinatura();
    const depois = await pers.estadoRecursosEmpresa(102);
    assert.equal(depois.recursos.find((r) => r.recurso === "fretes")!.liberado, false, "downgrade corta junto (cortesia expirada não sustenta)");
  });

  it("cortesia não contorna a suspensão da assinatura (gate comercial em pé)", async () => {
    sessaoAtual = SESSAO.plat;
    await inserirCortesia(103, "empresarial", localComOffset(-60), localComOffset(60 * 24));
    await billing.acaoPlataforma(103, "suspender");
    gate.resetCacheGateAssinatura();
    // A cortesia está ATIVA (tempo dentro da janela), mas a assinatura está
    // suspensa: o gate de assinatura roda nos pontos de entrada ANTES de
    // qualquer recurso ser resolvido — cortesia não é passe comercial.
    const ativa = await pers.cortesiaAtiva(103);
    assert.ok(ativa, "a cortesia vigente existe, mesmo com a conta suspensa");
    const bloqueio = await erroDe(() => gate.exigirAssinaturaAtiva({ company_id: 103, platform_admin: false }));
    assert.equal(bloqueio?.name, "AssinaturaBloqueadaError", "suspensa barra antes de qualquer recurso");
    await billing.acaoPlataforma(103, "reativar");
    gate.resetCacheGateAssinatura();
    await db.run(`DELETE FROM company_courtesies WHERE company_id = 103`);
  });

  it("duplo clique não duplica concessão idêntica", async () => {
    sessaoAtual = SESSAO.plat;
    const dados = {
      planSlug: "profissional",
      startsAt: localComOffset(-60),
      endsAt: localComOffset(60 * 6),
      motivo: "teste idempotência",
    };
    const r1 = await actions.criarCortesiaAction(102, dados);
    const r2 = await actions.criarCortesiaAction(102, dados);
    assert.equal(r1.ok, true);
    assert.equal(r2.ok, true, "a repetição é aceita como no-op");
    const n = await db.scalar<number>(
      `SELECT COUNT(*) FROM company_courtesies WHERE company_id = 102 AND reason = 'teste idempotência' AND canceled_at IS NULL`,
    );
    assert.equal(n, 1, "só UMA linha foi criada");
    await db.run(`DELETE FROM company_courtesies WHERE company_id = 102 AND reason = 'teste idempotência'`);
  });

  it("rotina diária registra início e término UMA única vez (idempotente)", async () => {
    await db.run(`DELETE FROM company_courtesies WHERE company_id IN (102,103)`);
    await inserirCortesia(103, "profissional", localComOffset(-60), localComOffset(60)); // ativa
    await inserirCortesia(102, "profissional", localComOffset(-60 * 48), localComOffset(-60)); // expirada
    const r1 = await pers.rotinaCortesias();
    // A expirada também "iniciou" no passado — a rotina registra os dois
    // marcos (início das duas, término da expirada).
    assert.equal(r1.iniciadas, 2, "registra o início das cortesias que já passaram do começo");
    assert.equal(r1.encerradas, 1, "registra o término da expirada");
    const r2 = await pers.rotinaCortesias();
    assert.deepEqual(r2, { iniciadas: 0, encerradas: 0 }, "segunda execução não duplica");
    const logs = await db.scalar<number>(
      `SELECT COUNT(*) FROM audit_logs WHERE action IN ('plataforma.cortesia_iniciada','plataforma.cortesia_encerrada')`,
    );
    assert.equal(logs, 3);
    await db.run(`DELETE FROM company_courtesies WHERE company_id IN (102,103)`);
    await db.run(`DELETE FROM audit_logs WHERE action IN ('plataforma.cortesia_iniciada','plataforma.cortesia_encerrada')`);
  });
});

/* ------------------------------------------------------------------ */
/* 5. LIMITE DE USUÁRIOS INDIVIDUAL                                    */
/* ------------------------------------------------------------------ */

describe("5) ajuste individual do limite de usuários", () => {
  it("limite ajustado é aplicado na criação (servidor) e removível", async () => {
    sessaoAtual = SESSAO.plat;
    // Essencial permite 3; a empresa já tem 5 ativos (11-14 + o platform_admin
    // 16, que mora na 101); ajuste para 6 libera UMA vaga.
    const r = await actions.salvarLimiteUsuariosAction(101, 6, "equipe ampliada");
    assert.equal(r.ok, true, r.mensagem);
    assert.equal(await billing.limiteUsuarios(101), 6, "limite efetivo vira 6");

    const novo = (n: string) => ({
      name: n,
      username: `pers-${n.toLowerCase()}`,
      email: `pers-${n.toLowerCase()}@teste.com`,
      password: "senha123",
      role: "operacional" as const,
    });
    const dono = ator(11, 101, "owner");
    const quinto = await usuarios.criarUsuario(dono, novo("Quinto"));
    assert.equal(quinto.ok, true, `o 6º usuário passa com o ajuste: ${!quinto.ok ? quinto.erro : ""}`);
    const sexto = await usuarios.criarUsuario(dono, novo("Sexto"));
    assert.equal(sexto.ok, false, "o 7º continua barrado");

    // Remove o ajuste: volta ao limite do plano (3) sem desativar ninguém.
    sessaoAtual = SESSAO.plat;
    const r2 = await actions.salvarLimiteUsuariosAction(101, null, "fim da exceção");
    assert.equal(r2.ok, true, r2.mensagem);
    assert.equal(await billing.limiteUsuarios(101), 3, "volta ao limite do plano");
    const ativos = await db.scalar<number>(`SELECT COUNT(*) FROM users WHERE company_id = 101 AND active = 1`);
    assert.equal(ativos, 6, "ninguém é desativado pela remoção do ajuste");
    // Limpeza para os demais testes.
    if (quinto.ok && quinto.id) await db.run(`UPDATE users SET active = 0 WHERE id = ?`, [quinto.id]);
    await db.run(`UPDATE users SET active = 0 WHERE username = 'pers-sextos' OR username = 'pers-sexto'`);
  });

  it("limite fora da faixa é recusado", async () => {
    sessaoAtual = SESSAO.plat;
    assert.equal((await actions.salvarLimiteUsuariosAction(101, 0, "x")).ok, false);
    assert.equal((await actions.salvarLimiteUsuariosAction(101, 9999, "x")).ok, false);
    assert.equal((await actions.salvarLimiteUsuariosAction(101, 2.5, "x")).ok, false);
  });
});

/* ------------------------------------------------------------------ */
/* 6. AUDITORIA                                                        */
/* ------------------------------------------------------------------ */

describe("6) auditoria das operações administrativas", () => {
  it("toda alteração grava antes/depois, responsável e motivo em audit_logs", async () => {
    sessaoAtual = SESSAO.plat;
    await actions.salvarRecursosEmpresaAction(103, [{ recurso: "portal", efeito: "liberar" }], "cliente premium");
    const log = await db.one<{ user_name: string; summary: string; meta: string }>(
      `SELECT user_name, summary, meta FROM audit_logs
        WHERE action = 'plataforma.recursos_ajustados' AND entity_id = 103 ORDER BY id DESC LIMIT 1`,
    );
    assert.ok(log, "registro de auditoria existe");
    assert.equal(log!.user_name, "Plataforma A", "responsável registrado");
    assert.match(String(log!.summary), /ajustad/i);
    const meta = JSON.parse(log!.meta);
    assert.equal(meta.motivo, "cliente premium");
    assert.equal(meta.antes.portal, "auto");
    assert.equal(meta.depois.portal, "allow");

    // Cortesia também audita.
    const c = await actions.criarCortesiaAction(103, {
      planSlug: "profissional",
      startsAt: localComOffset(-60),
      endsAt: localComOffset(60),
      motivo: "auditoria da cortesia",
    });
    assert.equal(c.ok, true, c.mensagem);
    const logC = await db.one<{ user_name: string; meta: string }>(
      `SELECT user_name, meta FROM audit_logs WHERE action = 'plataforma.cortesia_criada' AND entity_id = 103 ORDER BY id DESC LIMIT 1`,
    );
    assert.ok(logC, "criação de cortesia auditada");
    assert.equal(JSON.parse(logC!.meta).motivo, "auditoria da cortesia");

    // Limpeza do cenário.
    await db.run(`DELETE FROM company_feature_overrides WHERE company_id = 103`);
    await db.run(`DELETE FROM company_courtesies WHERE company_id = 103`);
  });

  it("o histórico da página do painel lista as alterações da empresa", async () => {
    sessaoAtual = SESSAO.plat;
    const logs = await db.all<{ action: string }>(
      `SELECT action FROM audit_logs WHERE entity = 'company' AND entity_id = 103 AND action LIKE 'plataforma.%'`,
    );
    assert.ok(logs.length >= 1, "a seção D da página tem o que mostrar");
  });
});
