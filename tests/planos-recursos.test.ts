/**
 * CORREÇÃO DE PLANOS — matrizes, gates e limites (cenários A a D da auditoria).
 *
 * Antes desta correção, qualquer plano com assinatura em dia usava portal,
 * chat, fidelidade, relatórios, fretes e contratos: não existia verificação de
 * recurso contratado em nenhuma camada. Aqui se prova, em camadas:
 *
 *  1. MATRIZ PURA: herança comercial, fail-closed sem plano conhecido e o
 *     mapeamento caminho/rota -> recurso (planos.ts).
 *  2. CENÁRIO A (Essencial): base funciona; chat/fidelidade/relatórios/
 *     fretes/contratos bloqueados em requireModule, requireModuleEdit e
 *     rota /api real; portal do cliente barrado no login e na área; limite
 *     de 3 usuários aplicado no servidor (inclusive na corrida de 2 a 1);
 *     fidelidade não pontua na conclusão de locação.
 *  3. CENÁRIO B (Profissional): recursos do Essencial + portal/chat/
 *     relatórios/fidelidade funcionam; fretes e contratos seguem barrados.
 *  4. CENÁRIO C (Empresarial): tudo funciona, limites 3/10/30 conferidos.
 *  5. CENÁRIO D (manipulação): URL restrita, API direta, plano por dado
 *     confiável (não de interface), papel interno × plano, assinatura
 *     ausente/falha, slug desconhecido, troca de plano em ambas as direções,
 *     duas empresas simultâneas, downgrade com usuários acima do limite,
 *     trial e reconciliação pelo painel /saas.
 *
 * Cenário E (regressão) = a suíte inteira, incluindo os testes legados.
 */
import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/* ------------------------------------------------------------------ */
/* Scaffold do Next (mesmo padrão de tests/assinatura-gate.test.ts)    */
/* ------------------------------------------------------------------ */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const carregarOriginal = (Module as any)._load;

let sessaoAtual = "";
let sessaoPortal = "";

(Module as any)._load = function (request: string) {
  if (request === "next/headers") {
    return {
      cookies: async () => ({
        get: (nome: string) => {
          if (nome === "limas_session" && sessaoAtual) return { value: sessaoAtual };
          if (nome === "limas_portal" && sessaoPortal) return { value: sessaoPortal };
          return undefined;
        },
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
/* Cenário: 4 empresas (1/4 Essencial, 2 Profissional, 3 Empresarial)  */
/* ------------------------------------------------------------------ */

const FUTURO = new Date(Date.now() + 864e5).toISOString();
const SESSAO = {
  donoEss: "sess-planos-dono-ess",
  operEss: "sess-planos-oper-ess",
  donoProf: "sess-planos-dono-prof",
  donoEmp: "sess-planos-dono-emp",
  operEmp: "sess-planos-oper-emp",
  plat: "sess-planos-plat",
};

let db: typeof import("../src/lib/db.ts");
let gate: typeof import("../src/lib/assinatura-gate.ts");
let planoGate: typeof import("../src/lib/plano-gate.ts");
let planos: typeof import("../src/lib/planos.ts");
let auth: typeof import("../src/lib/auth.ts");
let apiSecurity: typeof import("../src/lib/api-security.ts");
let billing: typeof import("../src/lib/billing.ts");
let usuarios: typeof import("../src/lib/usuarios.ts");
let portalAuth: typeof import("../src/lib/portal-auth.ts");
let portalCore: typeof import("../src/lib/portal-core.ts");

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

const ator = (id: number, company_id: number, role: string, name = "Ator") => ({ id, name, company_id, role: role as any });

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
      (4, 'Essencial Plat SA', 1, 'plat@teste')`,
  );

  const planId = async (slug: string) =>
    (await db.scalar<number>(`SELECT id FROM plans WHERE slug = ?`, [slug]))!;
  const hoje = new Date().toISOString().slice(0, 10);
  for (const [empresa, slug] of [
    [1, "essencial"],
    [2, "profissional"],
    [3, "empresarial"],
    [4, "essencial"],
  ] as const) {
    await db.run(
      `INSERT INTO subscriptions (company_id, plan_id, status, trial_ends_at, current_period_start, current_period_end)
       VALUES (?,?, 'trial', ?, ?, ?)`,
      [empresa, await planId(slug), FUTURO.slice(0, 10), hoje, FUTURO.slice(0, 10)],
    );
  }

  await db.run(
    `INSERT INTO users (id, name, username, password_hash, role, company_id, active, platform_admin) VALUES
      (81, 'Dono Essencial',   'planos-dono-ess',  'x', 'owner',        1, 1, 0),
      (82, 'Oper Essencial',   'planos-oper-ess',  'x', 'operacional',  1, 1, 0),
      (91, 'Dono Profissional', 'planos-dono-prof', 'x', 'owner',        2, 1, 0),
      (93, 'Dono Empresarial', 'planos-dono-emp',  'x', 'owner',        3, 1, 0),
      (94, 'Oper Empresarial', 'planos-oper-emp',  'x', 'operacional',  3, 1, 0),
      (84, 'Plat da plataforma','planos-plat',      'x', 'owner',        4, 1, 1)`,
  );
  for (const [id, sessao] of [
    [81, SESSAO.donoEss],
    [82, SESSAO.operEss],
    [91, SESSAO.donoProf],
    [93, SESSAO.donoEmp],
    [94, SESSAO.operEmp],
    [84, SESSAO.plat],
  ] as const) {
    await db.run(`INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)`, [sessao, id, FUTURO]);
  }

  // Clientes do portal (um por empresa) + sessões de portal.
  await db.run(`INSERT INTO customers (id, name, company_id) VALUES (51, 'Cliente Essencial', 1), (52, 'Cliente Profissional', 2)`);

  planos = await import("../src/lib/planos.ts");
  gate = await import("../src/lib/assinatura-gate.ts");
  planoGate = await import("../src/lib/plano-gate.ts");
  auth = await import("../src/lib/auth.ts");
  apiSecurity = await import("../src/lib/api-security.ts");
  billing = await import("../src/lib/billing.ts");
  usuarios = await import("../src/lib/usuarios.ts");
  portalAuth = await import("../src/lib/portal-auth.ts");
  portalCore = await import("../src/lib/portal-core.ts");
});

beforeEach(() => {
  gate.resetCacheGateAssinatura();
  sessaoAtual = SESSAO.donoEss;
  sessaoPortal = "";
});

/* ------------------------------------------------------------------ */
/* 1. MATRIZ PURA                                                      */
/* ------------------------------------------------------------------ */

describe("1) matriz comercial (fonte única de verdade)", () => {
  it("herança: essencial base, profissional +portal/chat/relatorios/fidelidade, empresarial +fretes/contratos/suporte", () => {
    const base = ["reservas", "orcamentos", "clientes", "estoque", "financeiro"] as const;
    for (const r of base) assert.equal(planos.planoInclui("essencial", r), true, `${r} é base`);
    for (const r of ["portal", "chat", "relatorios", "fidelidade", "fretes", "contratos", "suporte"] as const) {
      assert.equal(planos.planoInclui("essencial", r), false, `essencial não pode ${r}`);
    }
    for (const r of ["portal", "chat", "relatorios", "fidelidade"] as const) {
      assert.equal(planos.planoInclui("profissional", r), true, `profissional inclui ${r}`);
    }
    for (const r of ["fretes", "contratos", "suporte"] as const) {
      assert.equal(planos.planoInclui("profissional", r), false, `profissional NÃO inclui ${r}`);
    }
    for (const r of Object.keys(planos.RECURSOS) as (keyof typeof planos.RECURSOS)[]) {
      assert.equal(planos.planoInclui("empresarial", r), true, `empresarial inclui ${r}`);
    }
  });

  it("sem plano conhecido só os recursos fundamentais ficam abertos (fail-closed)", () => {
    assert.equal(planos.planoInclui(null, "reservas"), true);
    assert.equal(planos.planoInclui(undefined, "financeiro"), true);
    assert.equal(planos.planoInclui("plano-inventado", "chat"), false, "pago nunca abre por ausência de restrição");
  });

  it("mapeamento caminho/rota -> recurso: /api/routes é base compartilhada", () => {
    assert.equal(planos.recursoDaApi("/api/chat"), "chat");
    assert.equal(planos.recursoDaApi("/api/chat/unread"), "chat");
    assert.equal(planos.recursoDaApi("/api/portal/documento/1"), "portal");
    assert.equal(planos.recursoDaApi("/api/routes"), null, "cálculo de rota é compartilhado com reservas");
    assert.equal(planos.recursoDaApi("/api/push"), null);
    assert.equal(planos.recursoDoCaminho("/chat"), "chat");
    assert.equal(planos.recursoDoCaminho("/fretes/calculadora"), "fretes");
    assert.equal(planos.recursoDoCaminho("/dashboard"), null);
  });
});

/* ------------------------------------------------------------------ */
/* 2. CENÁRIO A — ESSENCIAL                                            */
/* ------------------------------------------------------------------ */

describe("2) cenário A (Essencial): base funciona, recursos pagos não", () => {
  it("módulos base seguem abertos (reservas, financeiro, dashboard, estoque)", async () => {
    assert.ok(await auth.requireModuleEdit("reservas"));
    assert.ok(await auth.requireModuleEdit("financeiro"));
    assert.ok(await auth.requireModule("dashboard"));
    assert.ok(await auth.requireModule("estoque"));
    assert.ok(await auth.requireModule("agenda"));
  });

  it("requireModule (páginas) redireciona para /plano-restrito nos módulos pagos", async () => {
    for (const [modulo, recurso] of [
      ["chat", "chat"],
      ["fidelidade", "fidelidade"],
      ["relatorios", "relatorios"],
      ["fretes", "fretes"],
      ["contratos", "contratos"],
    ] as const) {
      const e = await erroDe(() => auth.requireModule(modulo));
      assert.ok(ehRedirect(e, `/plano-restrito?recurso=${recurso}`), `${modulo} deveria redirecionar: ${e?.message}`);
    }
  });

  it("requireModuleEdit (actions) lança RecursoNaoContratadoError antes de gravar", async () => {
    // relatorios fica de fora: o módulo é somente-leitura (EDIT vazio), então
    // nem chega ao gate de plano — o papel barra antes (e o teste de páginas
    // já cobre o plano de relatórios).
    for (const modulo of ["fidelidade", "fretes", "contratos", "chat"] as const) {
      const e = await erroDe(() => auth.requireModuleEdit(modulo));
      assert.equal(e?.name, "RecursoNaoContratadoError", `${modulo} deveria lançar o erro de plano: ${e?.name}`);
      assert.match(String(e?.message), /upgrade/i, "a mensagem precisa apontar o upgrade");
    }
  });

  it("actions reais dos módulos pagos são barradas (chat-fidelidade, fretes, contratos)", async () => {
    const fidelidade = await carregar("src/app/(app)/reservas/fidelidade-actions.ts");
    const e1 = await erroDe(() => fidelidade.aplicarRecompensa(new FormData()));
    assert.equal(e1?.name, "RecursoNaoContratadoError", "aplicarRecompensa deveria ser barrado");

    const fretes = await carregar("src/app/(app)/fretes/actions.ts");
    const e2 = await erroDe(() => fretes.createFreight(null, new FormData()));
    assert.equal(e2?.name, "RecursoNaoContratadoError", "createFreight deveria ser barrado");

    const contratos = await carregar("src/app/(app)/contratos/actions.ts");
    const e3 = await erroDe(() => contratos.generateContract(new FormData()));
    assert.equal(e3?.name, "RecursoNaoContratadoError", "generateContract deveria ser barrado");
  });

  it("chamada direta à API do chat responde 403 (recurso_nao_contratado) sem ler nada", async () => {
    const rota = await carregar("src/app/api/chat/route.ts");
    const resposta = await rota.GET(new Request("http://localhost/api/chat"));
    assert.equal(resposta.status, 403, "API de recurso pago precisa negar com 403");
    const corpo = await resposta.json();
    assert.equal(corpo.code, "recurso_nao_contratado");
    assert.ok(!("conversations" in corpo), "nada do módulo pode vazar na resposta");
  });

  it("apiUser devolve 403 para /api/chat e continua autenticando as rotas base", async () => {
    const chat = await apiSecurity.apiUser(new Request("http://localhost/api/chat"));
    assert.ok(chat instanceof Response && chat.status === 403, "apiUser deve barrar /api/chat no plano Essencial");

    const rotas = await apiSecurity.apiUser(new Request("http://localhost/api/routes"));
    assert.ok(!(rotas instanceof Response), "/api/routes continua liberado (compartilhado com reservas)");

    const push = await apiSecurity.apiUser(new Request("http://localhost/api/push"));
    assert.ok(!(push instanceof Response), "/api/push continua liberado (notificações são base)");
  });

  it("portal do cliente: login recusado, área redirecionada e API responde 403", async () => {
    const sessao = await portalCore.abrirSessaoCliente(51); // cliente da empresa 1 (essencial)

    sessaoPortal = sessao;
    const e = await erroDe(() => portalAuth.requireCliente());
    assert.ok(ehRedirect(e, "/portal/login?bloqueio=plano"), "área do portal deve redirecionar: " + e?.message);

    const api = await carregar("src/app/api/portal/documento/[id]/route.ts");
    const r = await api.GET(new Request("http://localhost/api/portal/documento/1"), { params: Promise.resolve({ id: "1" }) });
    assert.equal(r.status, 403, "API do portal deve negar recurso não contratado");
    assert.equal((await r.json()).code, "recurso_nao_contratado");

    const arquivo = await carregar("src/app/api/portal/arquivo/[id]/route.ts");
    const ra = await arquivo.GET(new Request("http://localhost/api/portal/arquivo/abc"), { params: Promise.resolve({ id: "abc" }) });
    assert.equal(ra.status, 403, "arquivos do portal também são negados");
  });

  it("gerarConvitePortal é barrado com mensagem de upgrade", async () => {
    const portal = await carregar("src/app/(app)/clientes/portal-actions.ts");
    const fd = new FormData();
    fd.set("id", "51");
    const e = await erroDe(() => portal.gerarAcessoPortal(fd));
    assert.ok(ehRedirect(e) && String(e.message).includes("aviso="), "deveria redirecionar com aviso: " + e?.message);
  });

  it("fidelidade NÃO pontua na conclusão de locação sem o recurso (gate no hook)", async () => {
    // O hook de pontuação roda dentro de changeStatus, condicionado ao plano.
    const texto = fs.readFileSync(path.join(ROOT, "src/app/(app)/reservas/actions.ts"), "utf8");
    const i = texto.indexOf("export async function changeStatus");
    const corpo = texto.slice(i, texto.indexOf("export async function", i + 10));
    assert.ok(corpo.includes('temRecurso(user, "fidelidade")'), "changeStatus precisa condicionar a pontuação ao plano");
    assert.ok(corpo.includes("aoConcluirLocacao"), "o hook de fidelidade continua existindo para quem tem o plano");
  });
});

/* ------------------------------------------------------------------ */
/* 3. CENÁRIO B — PROFISSIONAL (trial ativo)                           */
/* ------------------------------------------------------------------ */

describe("3) cenário B (Profissional, em trial): base + portal/chat/relatórios/fidelidade", () => {
  beforeEach(() => {
    sessaoAtual = SESSAO.donoProf;
  });

  it("chat, fidelidade e relatórios liberados; fretes e contratos barrados", async () => {
    assert.ok(await auth.requireModule("chat"));
    assert.ok(await auth.requireModule("relatorios"));
    assert.ok(await auth.requireModuleEdit("fidelidade"));

    assert.equal((await erroDe(() => auth.requireModule("fretes")))?.message, "NEXT_REDIRECT:/plano-restrito?recurso=fretes");
    const e = await erroDe(() => auth.requireModuleEdit("contratos"));
    assert.equal(e?.name, "RecursoNaoContratadoError");
  });

  it("API do chat responde normalmente (200) para o plano que o contratou", async () => {
    const rota = await carregar("src/app/api/chat/route.ts");
    const resposta = await rota.GET(new Request("http://localhost/api/chat"));
    assert.notEqual(resposta.status, 403, "profissional não pode levar 403 no chat");
    assert.equal(resposta.status, 200);
  });

  it("portal do cliente funciona (sessão do cliente profissional passa)", async () => {
    sessaoPortal = await portalCore.abrirSessaoCliente(52);
    const cliente = await portalAuth.requireCliente();
    assert.equal(cliente.company_id, 2);
  });
});

/* ------------------------------------------------------------------ */
/* 4. CENÁRIO C — EMPRESARIAL + limites 3/10/30                        */
/* ------------------------------------------------------------------ */

describe("4) cenário C (Empresarial): tudo incluído; limites por plano", () => {
  it("fretes e contratos liberados (papel operacional inclusive, dentro do papel)", async () => {
    sessaoAtual = SESSAO.donoEmp;
    assert.ok(await auth.requireModule("fretes"));
    assert.ok(await auth.requireModuleEdit("contratos"));
    sessaoAtual = SESSAO.operEmp;
    assert.ok(await auth.requireModule("fretes"), "operacional continua respeitando papel, e papel dele permite fretes");
  });

  it("limites de usuários: 3 / 10 / 30 conforme o plano gravado", async () => {
    assert.equal(await billing.limiteUsuarios(1), 3);
    assert.equal(await billing.limiteUsuarios(2), 10);
    assert.equal(await billing.limiteUsuarios(3), 30);
  });

  it("suporte prioritário: sem módulo próprio hoje, mas presente na matriz", () => {
    assert.equal(planos.RECURSOS.suporte.minimo, "empresarial");
  });
});

/* ------------------------------------------------------------------ */
/* 5. CENÁRIO D — MANIPULAÇÃO E SEGURANÇA                              */
/* ------------------------------------------------------------------ */

describe("5) cenário D: manipulação, isolamento e estados", () => {
  it("D3: a autorização usa o dado gravado no servidor — flag/interface não muda nada", async () => {
    // Usuário comum (platform_admin=0) do plano Essencial não vira isento por
    // nada que o navegador mande; o gate só lê a assinatura da empresa.
    sessaoAtual = SESSAO.operEss;
    const e = await erroDe(() => auth.requireModule("chat"));
    assert.ok(ehRedirect(e, "/plano-restrito?recurso=chat"));
  });

  it("D2/D4: o plano de uma empresa não libera outra (company_id vem da sessão)", async () => {
    // Empresa 2 (profissional) está liberada; a 1, na mesma sessão de código, não.
    sessaoAtual = SESSAO.donoProf;
    assert.ok(await auth.requireModule("chat"));
    sessaoAtual = SESSAO.donoEss;
    const e = await erroDe(() => auth.requireModule("chat"));
    assert.ok(ehRedirect(e, "/plano-restrito?recurso=chat"));
  });

  it("D5: papel interno é aplicado independentemente do plano", async () => {
    sessaoAtual = SESSAO.operEmp; // Empresarial, papel operacional
    const e = await erroDe(() => auth.requireModule("configuracoes"));
    assert.ok(ehRedirect(e, "/dashboard?erro=permissao"), "papel sem acesso continua barrado: " + e?.message);
  });

  it("D6/D7: assinatura ilegível = fail-closed (área inteira bloqueada, nada libera)", async () => {
    await db.run(`ALTER TABLE subscriptions RENAME TO subscriptions_off`);
    try {
      gate.resetCacheGateAssinatura();
      const pagina = await erroDe(() => auth.requireModule("dashboard"));
      assert.ok(ehRedirect(pagina, "/assinatura-bloqueada"), "sem assinatura confirmada, nem base renderiza");
      const action = await erroDe(() => auth.requireModuleEdit("reservas"));
      assert.equal(action?.name, "AssinaturaBloqueadaError", "action também falha fechado");
    } finally {
      await db.run(`ALTER TABLE subscriptions_off RENAME TO subscriptions`);
      gate.resetCacheGateAssinatura();
    }
  });

  it("D6: plano com slug desconhecido (migração legada) mantém base e barra pago", async () => {
    await db.run(`UPDATE plans SET slug = 'legado-x' WHERE slug = 'essencial'`);
    try {
      assert.ok(await auth.requireModuleEdit("reservas"), "base continua funcionando");
      const e = await erroDe(() => auth.requireModuleEdit("fidelidade"));
      assert.equal(e?.name, "RecursoNaoContratadoError", "recurso pago falha fechado com slug desconhecido");
    } finally {
      await db.run(`UPDATE plans SET slug = 'essencial' WHERE slug = 'legado-x'`);
    }
  });

  it("D8/D9: upgrade libera na hora e downgrade corta na hora (sem cache velho)", async () => {
    assert.equal((await erroDe(() => auth.requireModule("chat")))?.message, "NEXT_REDIRECT:/plano-restrito?recurso=chat");

    await billing.trocarPlano(1, "profissional");
    assert.ok(await auth.requireModule("chat"), "chat deve abrir após o upgrade");
    assert.ok(await auth.requireModuleEdit("fidelidade"));

    await billing.trocarPlano(1, "empresarial");
    assert.ok(await auth.requireModuleEdit("fretes"), "fretes abre no empresarial");

    await billing.trocarPlano(1, "essencial");
    assert.equal(
      (await erroDe(() => auth.requireModule("chat")))?.message,
      "NEXT_REDIRECT:/plano-restrito?recurso=chat",
      "downgrade corta imediatamente (leitura sempre fresca)",
    );
  });

  it("D12: convite pendente do portal continua sendo do mesmo plano (cliente essencial barrado no 1º acesso)", async () => {
    const sessao = await portalCore.abrirSessaoCliente(51);
    sessaoPortal = sessao;
    const e = await erroDe(() => portalAuth.requireCliente());
    assert.ok(ehRedirect(e, "/portal/login?bloqueio=plano"));
  });

  it("D13: downgrade com usuários acima do novo limite preserva as contas e bloqueia só novas", async () => {
    // Empresa 3 (empresarial, 30) ganha 2 usuários extras e desce para essencial.
    const r1 = await usuarios.criarUsuario(ator(93, 3, "owner"), {
      name: "Extra Um",
      username: "planos-extra-um",
      email: "planos-extra-um@example.com",
      password: "senha123",
      role: "operacional",
    });
    assert.equal(r1.ok, true, "empresarial cria livremente");
    const r2 = await usuarios.criarUsuario(ator(93, 3, "owner"), {
      name: "Extra Dois",
      username: "planos-extra-dois",
      email: "planos-extra-dois@example.com",
      password: "senha123",
      role: "operacional",
    });
    assert.equal(r2.ok, true);

    await billing.trocarPlano(3, "essencial");
    const ativos = await db.scalar<number>(`SELECT COUNT(*) FROM users WHERE company_id = 3 AND active = 1`);
    assert.equal(ativos, 4, "ninguém é desativado ou excluído no downgrade");

    const r3 = await usuarios.criarUsuario(ator(93, 3, "owner"), {
      name: "Extra Três",
      username: "planos-extra-tres",
      email: "planos-extra-tres@example.com",
      password: "senha123",
      role: "operacional",
    });
    assert.equal(r3.ok, false);
    assert.match(String(!r3.ok && r3.erro), /Limite do plano/i);
    await billing.trocarPlano(3, "empresarial");
  });

  it("D14: usuário em trial gratuito usa os recursos do plano contratado", async () => {
    const sub = await db.one<{ status: string }>(`SELECT status FROM subscriptions WHERE company_id = 2`);
    assert.equal(sub?.status, "trial");
    sessaoAtual = SESSAO.donoProf;
    assert.ok(await auth.requireModule("chat"), "trial do profissional mantém o chat");
    assert.ok(await auth.requireModuleEdit("fidelidade"));
  });
});

/* ------------------------------------------------------------------ */
/* 6. LIMITES DE USUÁRIOS (servidor + corrida)                         */
/* ------------------------------------------------------------------ */

describe("6) limite de usuários no servidor, inclusive na corrida", () => {
  it("A5/D11: criação na vaga exata passa; a seguinte é barrada; duas simultâneas não furam o limite", async () => {
    const dono = ator(81, 1, "owner");
    // 2 ativos (81 dono + 82 oper) com limite 3.
    const terceiro = await usuarios.criarUsuario(dono, {
      name: "Terceiro",
      username: "planos-terceiro",
      email: "planos-terceiro@example.com",
      password: "senha123",
      role: "operacional",
    });
    assert.equal(terceiro.ok, true, "a última vaga do plano deve ser criável");

    const quarto = await usuarios.criarUsuario(dono, {
      name: "Quarto",
      username: "planos-quarto",
      email: "planos-quarto@example.com",
      password: "senha123",
      role: "operacional",
    });
    assert.equal(quarto.ok, false, "o 4º usuário não pode passar no plano Essencial");
    assert.match(String(!quarto.ok && quarto.erro), /Limite do plano/);

    // Reativar também ocupa vaga: inativado o terceiro, uma nova criação
    // fecha a empresa (3/3) e a reativação dele deve ser barrada.
    if (!(terceiro.ok && terceiro.id)) throw new Error("terceiro usuário deveria ter sido criado");
    await db.run(`UPDATE users SET active = 0 WHERE id = ?`, [terceiro.id]);
    const quinto = await usuarios.criarUsuario(dono, {
      name: "Quinto",
      username: "planos-quinto",
      email: "planos-quinto@example.com",
      password: "senha123",
      role: "operacional",
    });
    assert.equal(quinto.ok, true, "com o terceiro inativado, a vaga volta");
    const reativar = await usuarios.alternarStatusUsuario(dono, terceiro.id);
    assert.equal(reativar.ok, false, "reativação acima do limite é barrada no servidor");

    // Limpa para a corrida (volta a 2 ativos: 81 dono + 82 oper).
    await db.run(`UPDATE users SET active = 0 WHERE id IN (?, ?)`, [terceiro.id, quinto.ok ? quinto.id! : 0]);

    // CORRIDA: duas criações simultâneas com UMA vaga — só uma pode vencer,
    // porque o COUNT do limite está dentro do próprio INSERT/UPDATE.
    const novo = (n: string) => ({
      name: n,
      username: `planos-corrida-${n.toLowerCase()}`,
      email: `planos-corrida-${n.toLowerCase()}@example.com`,
      password: "senha123",
      role: "operacional",
    });
    const [a, b] = await Promise.all([
      usuarios.criarUsuario(dono, novo("Alpha")),
      usuarios.criarUsuario(dono, novo("Beta")),
    ]);
    const vencedoras = [a, b].filter((r) => r.ok).length;
    assert.equal(vencedoras, 1, "exatamente uma das duas corridas pode vencer");
    const ativos = await db.scalar<number>(`SELECT COUNT(*) FROM users WHERE company_id = 1 AND active = 1`);
    assert.equal(ativos, 3, "o limite final é respeitado");
  });
});

/* ------------------------------------------------------------------ */
/* 7. PAINEL /SAAS: reconciliação de plano e divergência               */
/* ------------------------------------------------------------------ */

describe("7) painel /saas: definir plano (reconciliação) + divergência", () => {
  it("operador da plataforma define o plano; usuário comum não", async () => {
    sessaoAtual = SESSAO.donoEss; // usuário comum tentando agir como plataforma
    const acao = await carregar("src/app/(saas)/saas/actions.ts");
    const negado = await erroDe(() => acao.definirPlanoAction(1, "empresarial"));
    assert.equal(negado?.name, "PermissionError", "só platform_admin pode definir plano");

    sessaoAtual = SESSAO.plat;
    const r = await acao.definirPlanoAction(1, "empresarial");
    assert.equal(r.ok, true, r.mensagem);
    assert.ok(await auth.requireModule("chat"), "a empresa vira empresarial e os recursos abrem");

    const audit = await db.scalar<number>(
      `SELECT COUNT(*) FROM audit_logs WHERE action = 'plataforma.definir_plano' AND entity_id = 1`,
    );
    assert.ok(audit! >= 1, "a troca precisa ficar registrada em audit_logs");

    const volta = await acao.definirPlanoAction(1, "essencial");
    assert.equal(volta.ok, true, volta.mensagem);
    sessaoAtual = SESSAO.donoEss; // platform_admin é isento do gate: o corte vale para a empresa
    assert.equal((await erroDe(() => auth.requireModule("chat")))?.message, "NEXT_REDIRECT:/plano-restrito?recurso=chat");
  });

  it("painel sinaliza divergência entre plano gravado e cobrança confirmada", async () => {
    // Plano essencial (7990) com cobrança confirmada de 24990 após a última
    // troca: o alerta precisa acender — sem alterar nada sozinho.
    await db.run(`UPDATE subscriptions SET updated_at = '2020-01-01 00:00:00' WHERE company_id = 1`);
    await db.run(
      `INSERT INTO subscription_payments (company_id, subscription_id, amount_cents, billing_type, status, due_date, paid_at, created_at)
       SELECT 1, s.id, 24990, 'PIX', 'confirmed', ?, ?, '2030-01-01 00:00:00' FROM subscriptions s WHERE s.company_id = 1`,
      [new Date().toISOString().slice(0, 10), new Date().toISOString()],
    );
    const alertas = await billing.alertasSaasPainel();
    const divergencia = alertas.find((a) => a.titulo.includes("divergentes") && a.titulo.includes("Lima"));
    assert.ok(divergencia, "o painel precisa sinalizar a divergência plano x cobrança");
    assert.equal(divergencia!.href, "/saas/assinaturas");
    await db.run(`DELETE FROM subscription_payments WHERE company_id = 1 AND amount_cents = 24990`);
  });
});

/* ------------------------------------------------------------------ */
/* 8. COBERTURA ESTÁTICA — o gate não pode sumir do código            */
/* ------------------------------------------------------------------ */

describe("8) cobertura estática dos gates de plano", () => {
  it("apiUser deriva o recurso do caminho; requireModule/requireModuleEdit usam o gate", () => {
    const api = fs.readFileSync(path.join(ROOT, "src/lib/api-security.ts"), "utf8");
    assert.ok(api.includes("recursoDaApi("), "apiUser precisa derivar o recurso do caminho");
    assert.ok(api.includes("respostaRecursoNaoContratado("), "apiUser precisa devolver 403 de recurso");

    const authTexto = fs.readFileSync(path.join(ROOT, "src/lib/auth.ts"), "utf8");
    assert.ok(authTexto.includes("bloquearRecurso(recurso"), "requireModule precisa redirecionar para a tela explicativa");
    assert.ok(authTexto.includes("exigirRecurso(ctx.user, recurso"), "requireModuleEdit precisa lançar o erro de plano");

    const portal = fs.readFileSync(path.join(ROOT, "src/lib/portal-auth.ts"), "utf8");
    assert.ok(portal.includes('temRecurso(') && portal.includes('"portal"'), "o portal precisa checar o plano");
  });

  it("entradas de módulos pagos FORA do menu são filtradas por temRecurso (relatório da UI)", () => {
    // Regressão dos dois apontamentos em testes práticos em staging:
    //  1) botão "Gerar Contrato" na reserva aparecia no Essencial/Profissional
    //     (o clique estourava o error boundary genérico em vez de tratar);
    //  2) Configurações mostrava as abas Frete/Fidelidade e os modelos de
    //     contrato para planos que não os contrataram.
    // O gate de BACKEND já existia (requireModuleEdit); o que faltava era a
    // apresentação seguir a MESMA matriz — este teste impede o retorno.
    const ler = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

    const reserva = ler("src/app/(app)/reservas/[id]/page.tsx");
    assert.ok(reserva.includes('temRecurso(user, "contratos")'), "reserva precisa consultar contratos antes de exibir a seção");
    assert.ok(reserva.includes("{contratoLiberado && ("), "a seção Contrato (e o botão Gerar Contrato) precisa estar condicionada ao plano");
    assert.ok(reserva.includes('temRecurso(user, "fidelidade")'), "reserva precisa consultar fidelidade antes de exibir recompensas");

    const config = ler("src/app/(app)/configuracoes/page.tsx");
    assert.ok(config.includes('temRecurso(user, "fretes")'), "configurações precisa consultar fretes");
    assert.ok(config.includes('temRecurso(user, "fidelidade")'), "configurações precisa consultar fidelidade");
    assert.ok(config.includes('temRecurso(user, "contratos")'), "configurações precisa consultar contratos");
    assert.ok(config.includes('bloquearRecurso("fretes"'), "URL direta ?aba=frete fora do plano deve cair em /plano-restrito");
    assert.ok(config.includes('bloquearRecurso("fidelidade"'), "URL direta ?aba=fidelidade fora do plano deve cair em /plano-restrito");
    assert.ok(config.includes('...(temFretes ? [{ value: "frete"'), "aba Frete precisa sumir do menu fora do plano");
    assert.ok(config.includes('...(temFidelidade ? [{ value: "fidelidade"'), "aba Fidelidade precisa sumir do menu fora do plano");

    // Ocultar os campos de contrato não pode APAGAR o modelo gravado: o
    // saveTemplates só escreve as chaves que vieram no FormData.
    const acoes = ler("src/app/(app)/configuracoes/actions.ts");
    assert.ok(acoes.includes('fd.has("contract_template")'), "saveTemplates deve ignorar modelos de contrato ausentes (nunca gravar \"\")");

    // Mesma classe: o atalho do lucro no dashboard não pode linkar /relatorios
    // para planos sem relatórios (o card permanece — só o link some).
    const dash = ler("src/app/(app)/dashboard/page.tsx");
    assert.ok(dash.includes('temRecurso(user, "relatorios")'), "dashboard precisa consultar relatorios antes de linkar o card de lucro");
  });
});
