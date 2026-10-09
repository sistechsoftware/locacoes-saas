/**
 * PENDÊNCIA #03 — Autorização por papel aplicada no BACKEND.
 *
 * Três camadas de verificação, todas contra a TABELA DOCUMENTADA aqui (cópia
 * independente da matriz de roles.ts — se alguém mudar a matriz sem mudar a
 * política, este teste falha):
 *
 *  1. MATRIZ: canView/canEdit de cada (papel × módulo) igual ao documentado.
 *  2. GUARDS REAIS: com sessão de cada um dos 5 papéis, requireModule redireciona
 *     com /dashboard?erro=permissao quando a matriz neega, e requireModuleEdit
 *     lança PermissionError — 5 papéis × 22 módulos. Actions reais spot-check.
 *  3. COBERTURA ESTÁTICA: toda página de módulo chama requireModule("<módulo>")
 *     e toda função exportada de server action tem guard — remover um guard
 *     derruba este teste.
 */
import { describe, it, before } from "node:test";
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

/** Sessão ativa — trocada por papel dentro dos testes. */
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

/* ------------------------------------------------------------------ */
/* TABELA DOCUMENTADA — a política comercial da matriz v1 (roles.ts).   */
/* Alterar a matriz exige alterar aqui, de propósito.                   */
/* ------------------------------------------------------------------ */

const PAPEIS = ["owner", "admin", "operacional", "financeiro", "viewer"] as const;
type Papel = (typeof PAPEIS)[number];
const TODOS: Papel[] = [...PAPEIS];

const VIEW: Record<string, Papel[]> = {
  dashboard: [...TODOS],
  agenda: [...TODOS],
  clientes: [...TODOS],
  produtos: ["owner", "admin", "operacional", "viewer"],
  estoque: ["owner", "admin", "operacional", "viewer"],
  reservas: [...TODOS],
  orcamentos: [...TODOS],
  contratos: ["owner", "admin", "operacional", "viewer"],
  recibos: [...TODOS],
  operacao: ["owner", "admin", "operacional", "viewer"],
  fretes: [...TODOS],
  financeiro: ["owner", "admin", "financeiro"],
  compras: [...TODOS],
  promocoes: ["owner", "admin", "operacional", "viewer"],
  fidelidade: ["owner", "admin", "operacional", "viewer"],
  chat: [...TODOS],
  relatorios: ["owner", "admin", "financeiro", "viewer"],
  notificacoes: [...TODOS],
  configuracoes: ["owner", "admin"],
  usuarios: ["owner", "admin"],
  assinatura: ["owner", "admin"],
  erros: ["owner", "admin"],
};

const EDIT: Record<string, Papel[]> = {
  dashboard: [],
  agenda: ["owner", "admin", "operacional"],
  clientes: ["owner", "admin", "operacional"],
  produtos: ["owner", "admin", "operacional"],
  estoque: ["owner", "admin", "operacional"],
  reservas: ["owner", "admin", "operacional"],
  orcamentos: ["owner", "admin", "operacional"],
  contratos: ["owner", "admin", "operacional"],
  recibos: ["owner", "admin", "operacional", "financeiro"],
  operacao: ["owner", "admin", "operacional"],
  fretes: ["owner", "admin", "operacional"],
  financeiro: ["owner", "admin", "financeiro"],
  compras: ["owner", "admin", "operacional"],
  promocoes: ["owner", "admin", "operacional"],
  fidelidade: ["owner", "admin", "operacional"],
  chat: [...TODOS],
  relatorios: [],
  notificacoes: ["owner", "admin", "operacional", "financeiro"],
  configuracoes: ["owner", "admin"],
  usuarios: ["owner", "admin"],
  assinatura: ["owner", "admin"],
  erros: ["owner", "admin"],
};

const MODULOS = Object.keys(VIEW);

/* ------------------------------------------------------------------ */
/* Cenário: 5 usuários na empresa 1, um por papel, com sessão ativa.    */
/* ------------------------------------------------------------------ */

const FUTURO = new Date(Date.now() + 864e5).toISOString();
const SESSAO: Record<Papel, string> = {
  owner: "sess-authz-owner",
  admin: "sess-authz-admin",
  operacional: "sess-authz-operacional",
  financeiro: "sess-authz-financeiro",
  viewer: "sess-authz-viewer",
};
const ID: Record<Papel, number> = { owner: 51, admin: 52, operacional: 53, financeiro: 54, viewer: 55 };

let auth: typeof import("../src/lib/auth.ts");

before(async () => {
  const { createTestDb } = await import("./helpers/d1.ts");
  createTestDb();
  const { run } = await import("../src/lib/db.ts");
  await run(
    `INSERT INTO users (id, name, username, password_hash, role, company_id, active) VALUES
      (51, 'Dono', 'authz-owner', 'x', 'owner', 1, 1),
      (52, 'Admin', 'authz-admin', 'x', 'admin', 1, 1),
      (53, 'Operador', 'authz-operacional', 'x', 'operacional', 1, 1),
      (54, 'Financeiro', 'authz-financeiro', 'x', 'financeiro', 1, 1),
      (55, 'Viewer', 'authz-viewer', 'x', 'viewer', 1, 1)`,
  );
  for (const p of PAPEIS) {
    await run(`INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)`, [SESSAO[p], ID[p], FUTURO]);
  }
  auth = await import("../src/lib/auth.ts");
});

const como = (p: Papel) => (sessaoAtual = SESSAO[p]);

/** Resultado de uma chamada de guard: o que voltou ou o erro lançado. */
async function guard(fn: () => Promise<unknown>): Promise<{ ok: boolean; ctx?: any; erro?: any }> {
  try {
    const ctx = await fn();
    return { ok: true, ctx };
  } catch (erro) {
    return { ok: false, erro };
  }
}

const ehPermissao = (e: any) => e?.name === "PermissionError";
const ehRedirect = (e: any) => String(e?.message ?? "").startsWith("NEXT_REDIRECT:/dashboard?erro=permissao");

/** true se a chamada NÃO foi barrada por papel (pode falhar por outro motivo). */
async function passouNoPapel(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch (e: any) {
    return !ehPermissao(e);
  }
}

function fd(pares: Record<string, string> = {}): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(pares)) f.set(k, v);
  return f;
}

const carregar = (rel: string) => import(pathToFileURL(path.resolve(ROOT, rel)).href);

/* ------------------------------------------------------------------ */
/* 1. MATRIZ                                                           */
/* ------------------------------------------------------------------ */

describe("1) matriz de papéis (roles.ts) igual à política documentada", () => {
  it("VIEW: cada módulo exibe exatamente para os papéis documentados", async () => {
    const { canView } = await import("../src/lib/roles.ts");
    for (const m of MODULOS) {
      for (const p of PAPEIS) {
        assert.equal(canView(p, m as any), VIEW[m].includes(p), `VIEW[${m}][${p}]`);
      }
    }
  });

  it("EDIT: cada módulo edita exatamente para os papéis documentados", async () => {
    const { canEdit } = await import("../src/lib/roles.ts");
    for (const m of MODULOS) {
      for (const p of PAPEIS) {
        assert.equal(canEdit(p, m as any), EDIT[m].includes(p), `EDIT[${m}][${p}]`);
      }
    }
  });

  it("owner e admin passam em TODOS os módulos (experiência preservada)", async () => {
    const { canView, canEdit } = await import("../src/lib/roles.ts");
    for (const m of MODULOS) {
      for (const p of ["owner", "admin"] as const) {
        assert.ok(canView(p, m as any), `owner/admin deve VER ${m}`);
        if (EDIT[m].length > 0) assert.ok(canEdit(p, m as any), `owner/admin deve EDITAR ${m}`);
      }
    }
  });
});

/* ------------------------------------------------------------------ */
/* 2. GUARDS REAIS: 5 papéis × 22 módulos                              */
/* ------------------------------------------------------------------ */

describe("2) requireModule: a PÁGINA redireciona exatamente quando a matriz nega", () => {
  for (const m of MODULOS) {
    it(`requireModule("${m}") × 5 papéis`, async () => {
      for (const p of PAPEIS) {
        como(p);
        const r = await guard(() => auth.requireModule(m as any));
        if (VIEW[m].includes(p)) {
          assert.ok(r.ok, `${p} deveria VER ${m}: ${!r.ok ? r.erro : ""}`);
          assert.equal(r.ok && r.ctx?.role, p, `ctx do papel errado em ${m}`);
        } else {
          assert.ok(!r.ok, `${p} NÃO deveria ver ${m}`);
          assert.ok(ehRedirect(r.erro), `esperava redirect ?erro=permissao em ${m}/${p}: ${r.erro}`);
        }
      }
    });
  }
});

describe("2b) requireModuleEdit: a ACTION lança PermissionError exatamente quando a matriz nega", () => {
  for (const m of MODULOS) {
    it(`requireModuleEdit("${m}") × 5 papéis`, async () => {
      for (const p of PAPEIS) {
        como(p);
        const r = await guard(() => auth.requireModuleEdit(m as any));
        if (EDIT[m].includes(p)) {
          assert.ok(r.ok, `${p} deveria EDITAR ${m}: ${!r.ok ? r.erro : ""}`);
        } else {
          assert.ok(!r.ok, `${p} NÃO deveria editar ${m}`);
          assert.ok(ehPermissao(r.erro), `esperava PermissionError em ${m}/${p}: ${r.erro}`);
        }
      }
    });
  }

  it("sem sessão: requireModule e requireModuleEdit mandam para /login", async () => {
    sessaoAtual = "";
    for (const fn of [() => auth.requireModule("dashboard"), () => auth.requireModuleEdit("dashboard")]) {
      const r = await guard(fn);
      assert.ok(!r.ok);
      assert.ok(String(r.erro?.message ?? "").includes("NEXT_REDIRECT:/login"), String(r.erro));
    }
  });
});

/* ------------------------------------------------------------------ */
/* 3. ACTIONS REAIS (spot-check dos fluxos da pendência)               */
/* ------------------------------------------------------------------ */

describe("3) actions reais respeitam a matriz", () => {
  it("createCustomer: viewer/financeiro barrados; operacional passa pelo papel", async () => {
    const { createCustomer } = await carregar("src/app/(app)/clientes/actions.ts");
    for (const p of ["viewer", "financeiro"] as const) {
      como(p);
      const r = await guard(() => createCustomer(null, fd({ name: "Teste" })));
      assert.ok(!r.ok && ehPermissao(r.erro), `${p} não deveria criar cliente: ${r.erro}`);
    }
    como("operacional");
    assert.ok(await passouNoPapel(() => createCustomer(null, fd({}))), "operacional não pode ser barrado por papel");
  });

  it("createReservation: viewer barrado; operacional passa pelo papel", async () => {
    const { createReservation } = await carregar("src/app/(app)/reservas/actions.ts");
    como("viewer");
    const r = await guard(() => createReservation(fd({})));
    assert.ok(!r.ok && ehPermissao(r.erro), `viewer não deveria criar reserva: ${r.erro}`);
    como("operacional");
    assert.ok(await passouNoPapel(() => createReservation(fd({}))), "operacional cria reserva no papel dele");
  });

  it("criarPagarManual (financeiro): viewer e operacional barrados; financeiro passa", async () => {
    const { criarPagarManual } = await carregar("src/app/(app)/financeiro/pagar-actions.ts");
    for (const p of ["viewer", "operacional"] as const) {
      como(p);
      const r = await guard(() => criarPagarManual(fd({})));
      assert.ok(!r.ok && ehPermissao(r.erro), `${p} não deveria lançar conta manual: ${r.erro}`);
    }
    como("financeiro");
    assert.ok(await passouNoPapel(() => criarPagarManual(fd({}))), "financeiro lança contas no papel dele");
  });

  it("addExpense (financeiro): operacional/viewer barrados; financeiro passa", async () => {
    const { addExpense } = await carregar("src/app/(app)/financeiro/actions.ts");
    for (const p of ["operacional", "viewer"] as const) {
      como(p);
      const r = await guard(() => addExpense(fd({})));
      assert.ok(!r.ok && ehPermissao(r.erro), `${p} não deveria lançar despesa: ${r.erro}`);
    }
    como("financeiro");
    assert.ok(await passouNoPapel(() => addExpense(fd({}))), "financeiro lança despesa no papel dele");
  });

  it("payEntry (compras OU financeiro): baixa de dinheiro; viewer barrado", async () => {
    const { payEntry } = await carregar("src/app/(app)/compras/actions.ts");
    como("viewer");
    const r = await guard(() => payEntry(fd({})));
    assert.ok(!r.ok && ehPermissao(r.erro), `viewer não deveria dar baixa: ${r.erro}`);
    for (const p of ["operacional", "financeiro"] as const) {
      como(p);
      assert.ok(await passouNoPapel(() => payEntry(fd({}))), `${p} deve poder dar baixa de compra`);
    }
  });

  it("payFreight (fretes OU financeiro): viewer barrado; financeiro e operacional passam", async () => {
    const { payFreight } = await carregar("src/app/(app)/fretes/actions.ts");
    como("viewer");
    const r = await guard(() => payFreight(fd({})));
    assert.ok(!r.ok && ehPermissao(r.erro), `viewer não deveria pagar frete: ${r.erro}`);
    for (const p of ["operacional", "financeiro"] as const) {
      como(p);
      assert.ok(await passouNoPapel(() => payFreight(fd({}))), `${p} deve poder pagar frete`);
    }
  });

  it("marcarMensagem (fidelidade): viewer barrado; operacional passa", async () => {
    const { marcarMensagem } = await carregar("src/app/(app)/fidelidade/actions.ts");
    como("viewer");
    const r = await guard(() => marcarMensagem(fd({ id: "1", status: "enviada" })));
    assert.ok(!r.ok && ehPermissao(r.erro), `viewer não deveria marcar mensagem: ${r.erro}`);
    como("operacional");
    assert.ok(await passouNoPapel(() => marcarMensagem(fd({ id: "999999", status: "dispensada" }))));
  });
});

/* ------------------------------------------------------------------ */
/* 4. COBERTURA ESTÁTICA — o guard não pode sumir da página/action     */
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

/** páginas transversais: sessão basta, não têm módulo próprio (aprovado no produto). */
const PAGINAS_TRANSVERSAIS = new Set([
  "src/app/(app)/busca/page.tsx",
  "src/app/(app)/historico/page.tsx",
  "src/app/(app)/assinatura-bloqueada/page.tsx",
]);

/** rota -> módulo exigido em requireModule("<módulo>"). */
const PAGINAS: Record<string, string> = {
  "src/app/(app)/agenda/page.tsx": "agenda",
  "src/app/(app)/aniversarios/page.tsx": "clientes",
  "src/app/(app)/chat/page.tsx": "chat",
  "src/app/(app)/clientes/page.tsx": "clientes",
  "src/app/(app)/clientes/novo/page.tsx": "clientes",
  "src/app/(app)/clientes/[id]/page.tsx": "clientes",
  "src/app/(app)/clientes/[id]/editar/page.tsx": "clientes",
  "src/app/(app)/compras/page.tsx": "compras",
  "src/app/(app)/compras/nova/page.tsx": "compras",
  "src/app/(app)/compras/[id]/page.tsx": "compras",
  "src/app/(app)/compras/[id]/editar/page.tsx": "compras",
  "src/app/(app)/configuracoes/page.tsx": "configuracoes",
  "src/app/(app)/contratos/page.tsx": "contratos",
  "src/app/(app)/contratos/[id]/page.tsx": "contratos",
  "src/app/(app)/contratos/assinado/[id]/page.tsx": "contratos",
  "src/app/(app)/dashboard/page.tsx": "dashboard",
  "src/app/(app)/disponibilidade/page.tsx": "agenda",
  "src/app/(app)/disponibilidade/timeline/page.tsx": "agenda",
  "src/app/(app)/erros/page.tsx": "erros",
  "src/app/(app)/estoque/page.tsx": "estoque",
  "src/app/(app)/estoque/novo/page.tsx": "estoque",
  "src/app/(app)/estoque/[id]/page.tsx": "estoque",
  "src/app/(app)/estoque/[id]/editar/page.tsx": "estoque",
  "src/app/(app)/faturamento/page.tsx": "assinatura",
  "src/app/(app)/fidelidade/page.tsx": "fidelidade",
  "src/app/(app)/financeiro/page.tsx": "financeiro",
  "src/app/(app)/fretes/page.tsx": "fretes",
  "src/app/(app)/fretes/novo/page.tsx": "fretes",
  "src/app/(app)/fretes/calculadora/page.tsx": "fretes",
  "src/app/(app)/fretes/[id]/page.tsx": "fretes",
  "src/app/(app)/fretes/[id]/editar/page.tsx": "fretes",
  "src/app/(app)/notificacoes/page.tsx": "notificacoes",
  "src/app/(app)/notificacoes/alertas/page.tsx": "notificacoes",
  "src/app/(app)/notificacoes/atividades/page.tsx": "notificacoes",
  "src/app/(app)/notificacoes/preferencias/page.tsx": "notificacoes",
  "src/app/(app)/operacao/page.tsx": "operacao",
  "src/app/(app)/operacao/nova/page.tsx": "operacao",
  "src/app/(app)/operacao/[id]/page.tsx": "operacao",
  "src/app/(app)/orcamentos/page.tsx": "orcamentos",
  "src/app/(app)/orcamentos/novo/page.tsx": "orcamentos",
  "src/app/(app)/orcamentos/[id]/page.tsx": "orcamentos",
  "src/app/(app)/orcamentos/[id]/editar/page.tsx": "orcamentos",
  "src/app/(app)/orcamentos/[id]/imprimir/page.tsx": "orcamentos",
  "src/app/(app)/promocoes/page.tsx": "promocoes",
  "src/app/(app)/promocoes/nova/page.tsx": "promocoes",
  "src/app/(app)/promocoes/[id]/page.tsx": "promocoes",
  "src/app/(app)/promocoes/[id]/editar/page.tsx": "promocoes",
  "src/app/(app)/recibos/[id]/page.tsx": "recibos",
  "src/app/(app)/relatorios/page.tsx": "relatorios",
  "src/app/(app)/reservas/page.tsx": "reservas",
  "src/app/(app)/reservas/nova/page.tsx": "reservas",
  "src/app/(app)/reservas/[id]/page.tsx": "reservas",
  "src/app/(app)/reservas/[id]/editar/page.tsx": "reservas",
};

const rel = (abs: string) => path.relative(ROOT, abs).split(path.sep).join("/");

describe("4) cobertura estática das PÁGINAS", () => {
  it("toda página de módulo existe na tabela e chama requireModule do módulo certo", () => {
    const paginas = walk(path.join(ROOT, "src/app/(app)"), (f) => f.endsWith("page.tsx")).map(rel);
    for (const p of paginas) {
      if (PAGINAS_TRANSVERSAIS.has(p)) continue;
      assert.ok(PAGINAS[p], `página nova sem módulo mapeado na tabela: ${p}`);
      const texto = fs.readFileSync(path.join(ROOT, p), "utf8");
      assert.ok(
        texto.includes(`requireModule("${PAGINAS[p]}")`),
        `${p} deveria exigir requireModule("${PAGINAS[p]}")`,
      );
      assert.ok(!/await requireUser\(/.test(texto), `${p} ainda usa requireUser — use requireModule`);
      assert.ok(!/await requireCompanyContext\(/.test(texto), `${p} ainda usa requireCompanyContext — use requireModule`);
    }
  });

  it("nenhuma página mapeada faltando na tabela (e nenhuma sobrando)", () => {
    const paginas = walk(path.join(ROOT, "src/app/(app)"), (f) => f.endsWith("page.tsx")).map(rel);
    const esperadas = new Set([...Object.keys(PAGINAS), ...PAGINAS_TRANSVERSAIS]);
    for (const p of paginas) assert.ok(esperadas.has(p), `página fora da tabela: ${p}`);
    for (const p of Object.keys(PAGINAS)) assert.ok(paginas.includes(p), `tabela aponta página inexistente: ${p}`);
  });
});

/* função autoatendimento/leitura: requireUser/documentado, por decisão de produto */
const MANTER_REQUIRE_USER = new Set([
  "changeOwnPassword",
  "saveMyAvatar",
  "removeMyAvatar",
  // Complemento cadastral do próprio usuário (contas antigas sem CPF/CNPJ):
  // autoatendimento documentado — valida e grava só o que falta nele mesmo.
  "completarCadastroAction",
  "markRead",
  "markAllRead",
  "markPersonalRead",
  "savePreferences",
  "checkStock",
  "temAdiantamentoAberto",
]);

/** registro silencioso de auditoria (sem sessão não loga, não bloqueia): */
const MANTER_CURRENT_USER = new Set(["logWhatsApp"]);

const GUARDS = ["requireModuleEdit", "requireUser", "assertAdmin", "requireModule", "requireAdmin", "assertPlatformAdmin", "currentUser"];

describe("5) cobertura estática das ACTIONS", () => {
  const arquivos = () =>
    walk(path.join(ROOT, "src/app/(app)"), (f) => f.endsWith(".ts") && fs.readFileSync(f, "utf8").includes('"use server"')).map(rel);

  it("toda função exportada de server action tem guard de sessão/papel", () => {
    for (const arq of arquivos()) {
      const texto = fs.readFileSync(path.join(ROOT, arq), "utf8");
      const partes = texto.split(/export async function /).slice(1);
      for (const parte of partes) {
        const nome = parte.split("(")[0].trim();
        const corpo = parte.slice(0, parte.indexOf("export async function") === -1 ? parte.length : parte.indexOf("export async function"));
        const temGuard = GUARDS.some((g) => corpo.includes(`await ${g}(`));
        assert.ok(temGuard, `${arq} :: ${nome} não tem nenhum guard (requireModuleEdit/requireUser/...)`);
        const ehManual = MANTER_REQUIRE_USER.has(nome);
        const ehLog = MANTER_CURRENT_USER.has(nome);
        if (!ehManual && !ehLog && !corpo.includes("await assertAdmin(") && !corpo.includes("await assertPlatformAdmin(")) {
          assert.ok(
            corpo.includes("await requireModuleEdit("),
            `${arq} :: ${nome} deve exigir requireModuleEdit (ou estar documentado como autoatendimento)`,
          );
        }
        if (ehManual) {
          assert.ok(
            corpo.includes("await requireUser("),
            `${arq} :: ${nome} é autoatendimento/leitura documentado — mantenha requireUser`,
          );
        }
        if (ehLog) {
          assert.ok(
            corpo.includes("await currentUser("),
            `${arq} :: ${nome} é log documentado — mantenha currentUser`,
          );
        }
      }
    }
  });

  it("actions sem requireModuleEdit algum só podem ser as de admin-only (assertAdmin)", () => {
    const adminOnly = new Set([
      "src/app/(app)/erros/actions.ts",
      "src/app/(app)/promocoes/actions.ts",
      "src/app/(app)/notificacoes/actions.ts",
    ]);
    for (const arq of arquivos()) {
      const texto = fs.readFileSync(path.join(ROOT, arq), "utf8");
      if (texto.includes("await requireModuleEdit(")) continue;
      assert.ok(adminOnly.has(arq), `${arq} não exige requireModuleEdit e não está na allowlist admin/pessoal`);
    }
  });

  it("logWhatsApp mantém currentUser (registro silencioso de auditoria)", () => {
    const texto = fs.readFileSync(path.join(ROOT, "src/app/(app)/reservas/actions.ts"), "utf8");
    const i = texto.indexOf("export async function logWhatsApp");
    const corpo = texto.slice(i, texto.indexOf("export async function", i + 10));
    assert.ok(corpo.includes("await currentUser()"), "logWhatsApp deve continuar com currentUser");
  });
});
