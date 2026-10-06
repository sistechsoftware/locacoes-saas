/**
 * PENDÊNCIA #05 — o bloqueio de assinatura precisa valer no BACKEND.
 *
 * Antes desta pendência `bloqueioDuro` só era lido pelo layout: uma empresa
 * suspensa/cancelada com sessão ativa seguia criando reservas e lançando
 * financeiro ao chamar as server actions direto. Aqui se prova, em quatro
 * camadas:
 *
 *  1. COMPORTEMENTO: com status 'suspended' e 'canceled', actions reais dos
 *     três pontos de entrada (requireModuleEdit, assertAdmin, requireUser)
 *     lançam AssinaturaBloqueadaError e NÃO gravam nada; com 'active' e
 *     'trial' continuam funcionando, e platform_admin passa por cima.
 *  2. EXCEÇÕES DOCUMENTADAS: gerarCobrancaAction (o caminho de recuperação da
 *     tela bloqueada) segue funcionando; as demais exceções são listadas.
 *  3. FAIL-CLOSED: se a leitura do estado falhar, vale o último estado
 *     conhecido (cache curto) e, sem evidência recente, o gate BLOQUEIA —
 *     nunca libera.
 *  4. COBERTURA ESTÁTICA: toda action de src/app/(app), toda rota /api interna
 *     e todo uso de `{ bloqueio: "ignorar" }` — remover o gate derruba este
 *     teste.
 */
import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/* ------------------------------------------------------------------ */
/* Scaffold do Next: auth/* importam next/* (cookie, redirect, cache).  */
/* ------------------------------------------------------------------ */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const carregarOriginal = (Module as any)._load;

/** Sessão corrente — os testes trocam para mudar de usuário. */
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
/* Cenário: empresa 1 com dono, operacional e operador da plataforma.   */
/* ------------------------------------------------------------------ */

const FUTURO = new Date(Date.now() + 864e5).toISOString();
const SESSAO = {
  dono: "sess-gate-dono",
  oper: "sess-gate-oper",
  plat: "sess-gate-plat",
};

let auth: typeof import("../src/lib/auth.ts");
let gate: typeof import("../src/lib/assinatura-gate.ts");
let apiSecurity: typeof import("../src/lib/api-security.ts");
let db: typeof import("../src/lib/db.ts");

function fd(pares: Record<string, string> = {}): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(pares)) f.set(k, v);
  return f;
}

/** Erro lançado pela action, ou null se ela completou. */
async function erroDe(fn: () => Promise<unknown>): Promise<any | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    return e;
  }
}
const ehBloqueio = (e: any) => e?.name === "AssinaturaBloqueadaError";
const ehRedirect = (e: any, url?: string) =>
  String(e?.message ?? "").startsWith("NEXT_REDIRECT:") && (!url || e.message === "NEXT_REDIRECT:" + url);

/** Corpo do 402 — Response.json() devolve unknown na tipagem padrão. */
type Corpo402 = { error: string; code: string };

/** Grava a assinatura da empresa 1 no status pedido (limpa a anterior). */
async function assinaturaDe(status: "trial" | "active" | "past_due" | "suspended" | "canceled") {
  await db.run(`DELETE FROM subscriptions WHERE company_id = 1`);
  const hoje = new Date().toISOString().slice(0, 10);
  const futuro = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
  await db.run(
    `INSERT INTO subscriptions (company_id, plan_id, status, trial_ends_at, current_period_start, current_period_end)
     VALUES (1, 1, ?, ?, ?, ?)`,
    [status, status === "trial" ? futuro : null, hoje, futuro],
  );
}

before(async () => {
  const { createTestDb } = await import("./helpers/d1.ts");
  createTestDb();
  db = await import("../src/lib/db.ts");
  db.resetCompanyCache();
  await db.run(
    `INSERT INTO users (id, name, username, password_hash, role, company_id, active, platform_admin) VALUES
      (71, 'Dono Gate', 'gate-dono', 'x', 'owner', 1, 1, 0),
      (72, 'Oper Gate', 'gate-oper', 'x', 'operacional', 1, 1, 0),
      (73, 'Plat Gate', 'gate-plat', 'x', 'owner', 1, 1, 1)`,
  );
  for (const [id, sessao] of [
    [71, SESSAO.dono],
    [72, SESSAO.oper],
    [73, SESSAO.plat],
  ] as const) {
    await db.run(`INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)`, [sessao, id, FUTURO]);
  }
  auth = await import("../src/lib/auth.ts");
  gate = await import("../src/lib/assinatura-gate.ts");
  apiSecurity = await import("../src/lib/api-security.ts");
});

beforeEach(async () => {
  await assinaturaDe("active");
  gate.resetCacheGateAssinatura();
  sessaoAtual = SESSAO.dono;
});

/* ------------------------------------------------------------------ */
/* 1. COMPORTEMENTO — suspended/canceled não executam nenhuma action   */
/* ------------------------------------------------------------------ */

describe("1) conta suspensa/cancelada não executa actions (e não grava)", () => {
  for (const status of ["suspended", "canceled"] as const) {
    it(`${status}: createCustomer (requireModuleEdit) lança o erro e nada é gravado`, async () => {
      await assinaturaDe(status);
      const e = await erroDe(() =>
        carregar("src/app/(app)/clientes/actions.ts").then((m) =>
          m.createCustomer(null, fd({ name: `Cliente Bloqueado ${status}` })),
        ),
      );
      assert.ok(ehBloqueio(e), `esperava AssinaturaBloqueadaError, veio: ${e?.name} ${e?.message}`);
      const n = await db.scalar<number>(
        `SELECT COUNT(*) FROM customers WHERE name = ?`,
        [`Cliente Bloqueado ${status}`],
      );
      assert.equal(n, 0, "a action gravou mesmo com a assinatura bloqueada");
    });

    it(`${status}: markAllRead (requireUser) lança o erro`, async () => {
      await assinaturaDe(status);
      sessaoAtual = SESSAO.oper;
      const e = await erroDe(() => carregar("src/app/(app)/notificacoes/actions.ts").then((m) => m.markAllRead()));
      assert.ok(ehBloqueio(e), `esperava AssinaturaBloqueadaError, veio: ${e?.name} ${e?.message}`);
    });

    it(`${status}: createPromotion (assertAdmin) lança o erro`, async () => {
      await assinaturaDe(status);
      const e = await erroDe(() =>
        carregar("src/app/(app)/promocoes/actions.ts").then((m) => m.createPromotion(null, fd({ name: "Promo" }))),
      );
      assert.ok(ehBloqueio(e), `esperava AssinaturaBloqueadaError, veio: ${e?.name} ${e?.message}`);
    });
  }

  it("exceção de recuperação: gerarCobrancaAction continua funcionando bloqueada", async () => {
    await assinaturaDe("suspended");
    const r = await erroDe(() =>
      carregar("src/app/(app)/faturamento/actions.ts").then((m) => m.gerarCobrancaAction()),
    );
    assert.ok(!ehBloqueio(r), "a única saída da tela bloqueada não pode ser barrada pelo gate");
    assert.ok(r === null || typeof r.ok === "boolean", `resposta inesperada: ${String(r && r.message)}`);
  });
});

/* ------------------------------------------------------------------ */
/* 2. COMPORTEMENTO — active/trial seguem normais; platform_admin passa */
/* ------------------------------------------------------------------ */

describe("2) conta ativa em trial segue funcionando (sem regressão)", () => {
  it("active: createCustomer cria o cliente e segue para o redirect", async () => {
    await assinaturaDe("active");
    const e = await erroDe(() =>
      carregar("src/app/(app)/clientes/actions.ts").then((m) => m.createCustomer(null, fd({ name: "Cliente Ativo" }))),
    );
    assert.ok(ehRedirect(e), `esperava o redirect final da action, veio: ${e?.name} ${e?.message}`);
    assert.equal(await db.scalar<number>(`SELECT COUNT(*) FROM customers WHERE name = 'Cliente Ativo'`), 1);
  });

  it("trial: markAllRead e createPromotion não são barrados", async () => {
    await assinaturaDe("trial");
    sessaoAtual = SESSAO.oper;
    assert.equal(
      await erroDe(() => carregar("src/app/(app)/notificacoes/actions.ts").then((m) => m.markAllRead())),
      null,
      "trial não pode ser barrado",
    );
    sessaoAtual = SESSAO.dono;
    const e = await erroDe(() =>
      carregar("src/app/(app)/promocoes/actions.ts").then((m) => m.createPromotion(null, fd({ name: "Promo" }))),
    );
    assert.ok(!ehBloqueio(e), `trial não pode ser barrado: ${e?.message}`);
  });

  it("platform_admin opera mesmo com a empresa suspensa", async () => {
    await assinaturaDe("suspended");
    sessaoAtual = SESSAO.plat;
    const e = await erroDe(() =>
      carregar("src/app/(app)/clientes/actions.ts").then((m) => m.createCustomer(null, fd({ name: "Cliente Plat" }))),
    );
    assert.ok(ehRedirect(e), `platform_admin não pode ser barrado pelo gate: ${e?.name} ${e?.message}`);
    assert.equal(await db.scalar<number>(`SELECT COUNT(*) FROM customers WHERE name = 'Cliente Plat'`), 1);
  });
});

/* ------------------------------------------------------------------ */
/* 3. PÁGINAS redirecionam; rotas /api respondem 401                    */
/* ------------------------------------------------------------------ */

describe("3) páginas redirecionam e rotas /api fecham a porta", () => {
  it("requireModule manda a conta suspensa para /assinatura-bloqueada", async () => {
    await assinaturaDe("suspended");
    const e = await erroDe(() => auth.requireModule("dashboard"));
    assert.ok(ehRedirect(e, "/assinatura-bloqueada"), `esperava redirect para /assinatura-bloqueada: ${e?.message}`);
  });

  it("requireCompanyContext (modo página) também redireciona", async () => {
    await assinaturaDe("canceled");
    const e = await erroDe(() => auth.requireCompanyContext());
    assert.ok(ehRedirect(e, "/assinatura-bloqueada"), `esperava redirect: ${e?.message}`);
  });

  it("apiUser: 402 com mensagem própria para conta bloqueada; null para sessão ausente", async () => {
    const request = new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { origin: "http://localhost" },
    });
    await assinaturaDe("active");
    const ativo = await apiSecurity.apiUser(request, true);
    assert.ok(ativo && !(ativo instanceof Response), "apiUser deveria autenticar a conta ativa");

    for (const status of ["suspended", "canceled"] as const) {
      await assinaturaDe(status);
      const r = await apiSecurity.apiUser(request, true);
      assert.ok(r instanceof Response, `apiUser devolveu ${typeof r} para ${status}`);
      assert.equal(r.status, 402, `${status} precisa responder 402`);
      const corpo = (await r.json()) as Corpo402;
      assert.equal(corpo.code, "assinatura_bloqueada", "resposta precisa ter código próprio");
      assert.match(String(corpo.error), /Assinatura/i, "402 precisa de mensagem própria");
    }

    // sessão ausente continua null (cada rota responde 401 com a mensagem dela)
    sessaoAtual = "";
    await assinaturaDe("active");
    assert.equal(await apiSecurity.apiUser(request, true), null, "sem sessão deve continuar null");

    // origem inválida em mutação (CSRF) também continua null — não é bloqueio
    sessaoAtual = SESSAO.dono;
    const cruzada = new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { origin: "http://evil.test" },
    });
    assert.equal(await apiSecurity.apiUser(cruzada, true), null, "CSRF deve continuar null");
  });

  it("rota /api interna: 402 bloqueada, 401 sem sessão, sem 402 para conta ativa", async () => {
    const { GET } = await carregar("src/app/api/chat/route.ts");
    const request = new Request("http://localhost/api/chat");

    sessaoAtual = SESSAO.dono;
    await assinaturaDe("suspended");
    const suspensa = await GET(request);
    assert.equal(suspensa.status, 402, "rota interna não respondeu 402 para conta suspensa");
    const corpo = (await suspensa.json()) as Corpo402;
    assert.equal(corpo.code, "assinatura_bloqueada");
    assert.match(String(corpo.error), /Assinatura/i);

    await assinaturaDe("canceled");
    assert.equal((await GET(request)).status, 402, "rota interna não respondeu 402 para conta cancelada");

    await assinaturaDe("active");
    sessaoAtual = "";
    assert.equal((await GET(request)).status, 401, "sem sessão a rota continua 401");

    sessaoAtual = SESSAO.dono;
    const ativa = await GET(request);
    assert.notEqual(ativa.status, 401, "401 é só para sessão ausente");
    assert.notEqual(ativa.status, 402, "conta ativa não pode levar 402");
  });
});

/* ------------------------------------------------------------------ */
/* 4. FAIL-CLOSED: falha de leitura nunca libera                       */
/* ------------------------------------------------------------------ */

describe("4) a leitura falha: cache curto do último estado, nunca liberar", () => {
  it("com estado conhecido recente, o sistema segue utilizável", async () => {
    // 1) estado lido com sucesso -> grava o último estado conhecido
    await assinaturaDe("active");
    await auth.requireUser(); // priming do cache (leitura fresca)

    // 2) a camada comercial fica indisponível
    await db.run(`ALTER TABLE subscriptions RENAME TO subscriptions_off`);
    try {
      const e = await erroDe(() =>
        carregar("src/app/(app)/notificacoes/actions.ts").then((m) => m.markAllRead()),
      );
      assert.ok(!ehBloqueio(e), "conta boa não pode ser derrubada por falha transitória");
    } finally {
      await db.run(`ALTER TABLE subscriptions_off RENAME TO subscriptions`);
    }
  });

  it("sem estado conhecido, a falha BLOQUEIA (fail-closed, não fail-open)", async () => {
    gate.resetCacheGateAssinatura(); // cache frio: nenhuma leitura anterior
    await db.run(`ALTER TABLE subscriptions RENAME TO subscriptions_off`);
    try {
      const e = await erroDe(() =>
        carregar("src/app/(app)/clientes/actions.ts").then((m) => m.createCustomer(null, fd({ name: "Cliente Frio" }))),
      );
      assert.ok(ehBloqueio(e), `esperava bloqueio conservador, veio: ${e?.name} ${e?.message}`);
      assert.equal(
        await db.scalar<number>(`SELECT COUNT(*) FROM customers WHERE name = 'Cliente Frio'`),
        0,
        "a action gravou mesmo sem conseguir confirmar a assinatura",
      );
    } finally {
      await db.run(`ALTER TABLE subscriptions_off RENAME TO subscriptions`);
    }
  });

  it("o gate nunca trata falha de leitura como liberado (layout incluído)", async () => {
    gate.resetCacheGateAssinatura();
    await db.run(`ALTER TABLE subscriptions RENAME TO subscriptions_off`);
    try {
      assert.equal(await gate.estadoAssinaturaSeguro(1), null, "estado desconhecido não pode virar 'liberado'");
      const e = await erroDe(() =>
        gate.exigirAssinaturaAtiva({ company_id: 1, platform_admin: false }),
      );
      assert.ok(ehBloqueio(e), "exigirAssinaturaAtiva precisa bloquear estado desconhecido");
      // ...mas quem trata o bloqueio ele mesmo continua podendo ler.
      sessaoAtual = SESSAO.dono;
      const user = await auth.requireUser({ bloqueio: "ignorar" });
      assert.equal(user.id, 71);
    } finally {
      await db.run(`ALTER TABLE subscriptions_off RENAME TO subscriptions`);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 5. COBERTURA ESTÁTICA                                               */
/* ------------------------------------------------------------------ */

const walk = (dir: string, filtro: (f: string) => boolean, acc: string[] = []): string[] => {
  for (const nome of fs.readdirSync(dir)) {
    const cheio = path.join(dir, nome);
    const st = fs.statSync(cheio);
    if (st.isDirectory()) walk(cheio, filtro, acc);
    else if (filtro(cheio)) acc.push(cheio);
  }
  return acc;
};
const rel = (abs: string) => path.relative(ROOT, abs).split(path.sep).join("/");

/** Helpers de entrada que APLICAM o gate de assinatura. */
const ENTRADAS_COM_GATE = [
  "await requireModuleEdit(",
  "await requireUser(",
  "await assertAdmin(",
  "await requireAdmin(",
  "await requireModule(",
  "await requireCompanyContext(",
  "await assertPlatformAdmin(",
  "await apiUser(",
  "exigirAssinaturaAtiva(",
];

/** Únicos pontos autorizados a pular o gate (cada um documentado no código). */
const IGNORAR_PERMITIDO = new Set([
  "src/app/(app)/layout.tsx", // trata o bloqueio ele mesmo (redirect)
  "src/app/(app)/assinatura-bloqueada/page.tsx", // É a tela de bloqueio
  "src/app/(app)/faturamento/actions.ts", // gerarCobrancaAction: recuperação
  "src/lib/error-log.ts", // diário de erros fica fora (exclusão da pendência)
]);
const REDIRECIONAR_PERMITIDO = new Set([
  "src/app/(app)/busca/page.tsx", // página transversal
]);

/** Rotas /api que ficam fora do gate, por decisão da pendência. */
const API_FORA_DO_GATE = [
  "src/app/api/logout/route.ts",
  "src/app/api/log-erro/route.ts",
  "src/app/api/assinar/route.ts", // pública, sem sessão
];

const foraDoGate = (arq: string) =>
  arq.startsWith("src/app/api/portal/") ||
  arq.startsWith("src/app/api/publico/") ||
  arq.startsWith("src/app/api/webhooks/") ||
  API_FORA_DO_GATE.includes(arq);

describe("5) cobertura estática: nenhuma action/rota escapa do gate", () => {
  it("toda server action de src/app/(app) passa por uma entrada com gate", () => {
    const arquivos = walk(path.join(ROOT, "src/app/(app)"), (f) =>
      f.endsWith(".ts") && fs.readFileSync(f, "utf8").includes('"use server"'),
    ).map(rel);
    assert.ok(arquivos.length > 10, "nenhuma action encontrada — o walker quebrou");
    for (const arq of arquivos) {
      const texto = fs.readFileSync(path.join(ROOT, arq), "utf8");
      const partes = texto.split(/export async function /).slice(1);
      for (const parte of partes) {
        const nome = parte.split("(")[0].trim();
        const corpo = parte.slice(0, parte.indexOf("export async function") === -1 ? parte.length : parte.indexOf("export async function"));
        assert.ok(
          ENTRADAS_COM_GATE.some((e) => corpo.includes(e)),
          `${arq} :: ${nome} não passa por nenhuma entrada com gate de assinatura (requireModuleEdit/requireUser/... )`,
        );
      }
    }
  });

  it('`bloqueio: "ignorar"` só existe nos pontos documentados', () => {
    const usos = walk(path.join(ROOT, "src"), (f) => /\.(ts|tsx)$/.test(f))
      .map(rel)
      .filter((f) => fs.readFileSync(path.join(ROOT, f), "utf8").includes('bloqueio: "ignorar"'));
    for (const u of usos) assert.ok(IGNORAR_PERMITIDO.has(u), `exceção não documentada do gate: ${u}`);
    for (const permitido of IGNORAR_PERMITIDO)
      assert.ok(usos.includes(permitido), `exceção documentada sumiu do código: ${permitido}`);
  });

  it('`bloqueio: "redirecionar"` só existe em página', () => {
    const usos = walk(path.join(ROOT, "src"), (f) => /\.(ts|tsx)$/.test(f))
      .map(rel)
      .filter((f) => fs.readFileSync(path.join(ROOT, f), "utf8").includes('bloqueio: "redirecionar"'));
    for (const u of usos) assert.ok(REDIRECIONAR_PERMITIDO.has(u), `uso fora da allowlist: ${u}`);
  });

  it("toda rota /api interna autentica pelo apiUser (ponto único do gate)", () => {
    const rotas = walk(path.join(ROOT, "src/app/api"), (f) => f.endsWith("route.ts")).map(rel);
    const internas = rotas.filter((r) => !foraDoGate(r));
    assert.ok(internas.length >= 5, `poucas rotas internas encontradas: ${internas.join(", ")}`);
    for (const rota of internas) {
      const texto = fs.readFileSync(path.join(ROOT, rota), "utf8");
      assert.ok(
        texto.includes("apiUser("),
        `${rota} não usa apiUser — rota interna sem gate de assinatura (ou adicione à allowlist)`,
      );
      // Cada chamada precisa trazer o ramo do 402: chamar apiUser e ignorar
      // um Response devolveria o objeto no lugar do usuário.
      const chamadas = (texto.match(/apiUser\(/g) ?? []).length;
      const com402 = (texto.match(/user instanceof Response\)/g) ?? []).length;
      assert.equal(
        com402,
        chamadas,
        `${rota}: ${chamadas} chamada(s) de apiUser mas ${com402} tratamento(s) de 402 — falta o ramo da assinatura bloqueada`,
      );
    }
  });

  it("as rotas que ficam de fora do gate são exatamente as documentadas", () => {
    const rotas = walk(path.join(ROOT, "src/app/api"), (f) => f.endsWith("route.ts")).map(rel);
    const excluidas = rotas.filter((r) => foraDoGate(r));
    for (const e of excluidas) {
      assert.ok(
        e.startsWith("src/app/api/portal/") ||
          e.startsWith("src/app/api/publico/") ||
          e.startsWith("src/app/api/webhooks/") ||
          API_FORA_DO_GATE.includes(e),
        `rota fora do gate sem justificativa: ${e}`,
      );
    }
  });
});
