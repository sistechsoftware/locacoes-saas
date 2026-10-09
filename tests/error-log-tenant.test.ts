/**
 * PENDÊNCIA #07 — escopo de empresa do diário de erros (error_logs).
 *
 * Prova o critério de aceitação da pendência:
 *   1. o erro da EMPRESA 2 aparece só para a empresa 2 e para o
 *      platform_admin (visão sem filtro);
 *   2. o erro GLOBAL (company_id NULL) aparece SÓ para o platform_admin —
 *      nenhuma empresa o enxerga;
 *   3. a migration 0036 deixa a coluna anulável SEM apagar dados e faz o
 *      backfill das linhas legadas (cron pelo context; resto vira global).
 *
 * Banco SQLite real com as migrations reais (tests/helpers/d1.ts) e scaffold
 * mínimo de next/* para renderizar a página /erros fora do runtime do Next.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createTestDb, resetTestDb } from "./helpers/d1";

/* ------------------------------------------------------------------ */
/* Scaffold do Next: a página importa next/*, que exige o runtime.     */
/* ------------------------------------------------------------------ */

const SESSAO_A = "sess-07-empresa-a";
const SESSAO_B = "sess-07-empresa-zb";
const SESSAO_P = "sess-07-plataforma";
/** Sessão corrente — os testes trocam para renderizar como cada usuário. */
let sessaoAtual: string | null = SESSAO_A;
const carregarOriginal = (Module as any)._load;

(Module as any)._load = function (request: string) {
  if (request === "next/headers") {
    return {
      cookies: async () => ({
        get: (nome: string) =>
          nome === "limas_session" && sessaoAtual ? { value: sessaoAtual } : undefined,
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
    const fake: any = (p: any) => p?.children ?? null;
    return { __esModule: true, default: fake, Link: fake };
  }
  if (request === "server-only") return {};
  return carregarOriginal.apply(this, arguments as any);
};

/** Importa um módulo da aplicação a partir da raiz do projeto (tsx). */
const carregar = (rel: string) => import(pathToFileURL(path.resolve(rel)).href);
/** Importa um módulo relativo a este arquivo de teste (ESM resolve pelo referrer). */
const relativo = (rel: string) => import(rel);

/* ------------------------------------------------------------------ */
/* Cenário: 2 empresas + operador da plataforma                       */
/* ------------------------------------------------------------------ */

/** Marcadores — cada erro tem um texto distinto para as asserções. */
const ERRO_A = "Erro da Empresa A"; // company_id 1
const ERRO_ZB = "Erro ZB da Empresa 2"; // company_id 2
const ERRO_GLOBAL = "Erro global da plataforma"; // company_id NULL

function futuro(): string {
  return new Date(Date.now() + 864e5).toISOString();
}

async function montarCenario() {
  const { run } = await relativo("../src/lib/db.ts");
  await run(`UPDATE companies SET name = 'Empresa A' WHERE id = 1`);
  await run(`INSERT INTO companies (id, name, active) VALUES (2, 'Empresa ZB', 1)`);
  await run(
    `INSERT INTO users (id, name, username, password_hash, role, company_id, active, platform_admin) VALUES
      (10, 'Dono A', 'erro07-dono-a', 'x', 'owner', 1, 1, 0),
      (20, 'Dono ZB', 'erro07-dono-b', 'x', 'owner', 2, 1, 0),
      (30, 'Operador da Plataforma', 'erro07-plataforma', 'x', 'owner', 1, 1, 1)`,
  );
  await run(`INSERT INTO sessions (id, user_id, expires_at) VALUES (?, 10, ?)`, [SESSAO_A, futuro()]);
  await run(`INSERT INTO sessions (id, user_id, expires_at) VALUES (?, 20, ?)`, [SESSAO_B, futuro()]);
  await run(`INSERT INTO sessions (id, user_id, expires_at) VALUES (?, 30, ?)`, [SESSAO_P, futuro()]);
  // gate de assinatura (pendência #05): as duas empresas precisam de acesso
  await run(
    `INSERT INTO subscriptions (id, company_id, plan_id, status, current_period_end) VALUES
      (100, 1, 1, 'active', '2027-12-31'), (200, 2, 1, 'active', '2027-12-31')`,
  );

  // As três linhas canônicas do cenário (gravadas pelo próprio registrarErro,
  // com escopo explícito — é o caminho dos chamadores em produção).
  const { registrarErro } = await carregar("src/lib/error-log.ts");
  await registrarErro({ source: "cron", kind: "server", message: ERRO_A, companyId: 1 });
  await registrarErro({ source: "cron", kind: "server", message: ERRO_ZB, companyId: 2 });
  await registrarErro({ source: "cron", kind: "server", message: ERRO_GLOBAL, companyId: null });
}

beforeEach(async () => {
  resetTestDb();
  const db = await relativo("../src/lib/db.ts");
  db.resetCompanyCache();
  createTestDb();
  sessaoAtual = SESSAO_A;
  await montarCenario();
});

afterEach(() => {
  resetTestDb();
  sessaoAtual = SESSAO_A;
});

/** Renderiza a página REAL de /erros e serializa para asserção de texto. */
async function renderizarErros() {
  if (!(globalThis as any).React) (globalThis as any).React = await import("react");
  const mod = await carregar("src/app/(app)/erros/page.tsx");
  const out = await mod.default({ params: Promise.resolve({}), searchParams: Promise.resolve({}) });
  return JSON.stringify(out, (_k, v) => (v === "type" ? undefined : v));
}

/* ------------------------------------------------------------------ */
/* 1. Leitura por escopo                                               */
/* ------------------------------------------------------------------ */

describe("PENDÊNCIA #07 — leitura por escopo do diário de erros", () => {
  it("erro da empresa 2 aparece SÓ para a empresa 2", async () => {
    const { contarErros, ultimosErros } = await carregar("src/lib/error-log.ts");
    assert.equal(await contarErros("server", 2), 1, "empresa 2 não contou só o próprio erro");
    const linhas = await ultimosErros("server", 50, 0, 2);
    assert.equal(linhas.length, 1);
    assert.equal(linhas[0].message, ERRO_ZB);
  });

  it("empresa 1 não vê o erro da empresa 2 nem o global", async () => {
    const { contarErros, ultimosErros } = await carregar("src/lib/error-log.ts");
    assert.equal(await contarErros("server", 1), 1, "empresa 1 contou erro que não é seu");
    const linhas = await ultimosErros("server", 50, 0, 1);
    assert.deepEqual(
      linhas.map((l: any) => l.message),
      [ERRO_A],
      "empresa 1 enxergou erro de outro tenant ou erro global",
    );
  });

  it("erro global (company_id NULL) não aparece para nenhuma empresa", async () => {
    const { contarErros, ultimosErros } = await carregar("src/lib/error-log.ts");
    for (const escopo of [1, 2]) {
      assert.equal(await contarErros("server", escopo), 1, `empresa ${escopo} contou o erro global`);
      const linhas = await ultimosErros("server", 50, 0, escopo);
      assert.ok(
        !linhas.some((l: any) => l.message === ERRO_GLOBAL),
        `erro global vazou para a empresa ${escopo}`,
      );
    }
  });

  it("visão sem filtro (platform_admin) vê todos, inclusive o global", async () => {
    const { contarErros, ultimosErros } = await carregar("src/lib/error-log.ts");
    // escopo null = platform_admin (page.tsx: user.platform_admin ? null : user.company_id)
    assert.equal(await contarErros("server", null), 3);
    const linhas = await ultimosErros("server", 50, 0, null);
    const mensagens = linhas.map((l: any) => l.message);
    for (const esperado of [ERRO_A, ERRO_ZB, ERRO_GLOBAL]) {
      assert.ok(mensagens.includes(esperado), `visão global não mostrou: ${esperado}`);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 2. Página /erros (a interface real do critério)                     */
/* ------------------------------------------------------------------ */

describe("PENDÊNCIA #07 — página /erros respeita o escopo da sessão", () => {
  it("/erros como empresa 2 vê só o erro da empresa 2", async () => {
    sessaoAtual = SESSAO_B;
    const json = await renderizarErros();
    assert.ok(json.includes(ERRO_ZB), "/erros não mostrou o erro da própria empresa 2");
    assert.ok(!json.includes("Erro da Empresa A"), "/erros vazou erro da empresa 1");
    assert.ok(!json.includes("global"), "/erros vazou o erro global para a empresa 2");
  });

  it("/erros como empresa 1 não vê a empresa 2 nem o global", async () => {
    sessaoAtual = SESSAO_A;
    const json = await renderizarErros();
    assert.ok(json.includes(ERRO_A), "/erros não mostrou o erro da própria empresa 1");
    assert.ok(!json.includes("ZB"), "/erros vazou erro da empresa 2");
    assert.ok(!json.includes("global"), "/erros vazou o erro global para a empresa 1");
  });

  it("/erros como platform_admin vê tudo, inclusive o global", async () => {
    sessaoAtual = SESSAO_P;
    const json = await renderizarErros();
    for (const esperado of [ERRO_A, ERRO_ZB, ERRO_GLOBAL]) {
      assert.ok(json.includes(esperado), `/erros (visão global) não mostrou: ${esperado}`);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 3. Resolução automática do company_id                              */
/* ------------------------------------------------------------------ */

describe("PENDÊNCIA #07 — registrarErro resolve o escopo sozinho", () => {
  it("request sem companyId explícito grava na empresa da SESSÃO", async () => {
    const { registrarErro } = await carregar("src/lib/error-log.ts");
    const { one } = await relativo("../src/lib/db.ts");

    sessaoAtual = SESSAO_B;
    const idB = await registrarErro({ source: "api/log-erro", kind: "client", message: "client da sessao B" });
    sessaoAtual = SESSAO_A;
    const idA = await registrarErro({ source: "api/log-erro", kind: "client", message: "client da sessao A" });

    assert.equal((await one(`SELECT company_id FROM error_logs WHERE id = ?`, [idB]))?.company_id, 2);
    assert.equal((await one(`SELECT company_id FROM error_logs WHERE id = ?`, [idA]))?.company_id, 1);
  });

  it("cron sem sessão grava na empresa do contexto runWithCompany", async () => {
    const { registrarErro } = await carregar("src/lib/error-log.ts");
    const { one, runWithCompany } = await relativo("../src/lib/db.ts");
    sessaoAtual = null; // cron não tem cookie de sessão

    const id = await runWithCompany(2, async () =>
      registrarErro({ source: "cron", kind: "server", message: "falha no cron da ZB" }),
    );
    assert.equal((await one(`SELECT company_id FROM error_logs WHERE id = ?`, [id]))?.company_id, 2);

    // contexto restaurado fora do loop → a linha seguinte não herda a empresa
    const idDepois = await registrarErro({ source: "cron", kind: "server", message: "fora do contexto" });
    assert.equal((await one(`SELECT company_id FROM error_logs WHERE id = ?`, [idDepois]))?.company_id, null);
  });

  it("sem sessão e sem contexto o erro é GLOBAL (NULL), nunca a empresa 1", async () => {
    const { registrarErro } = await carregar("src/lib/error-log.ts");
    const { one } = await relativo("../src/lib/db.ts");
    sessaoAtual = null;
    const id = await registrarErro({ source: "onRequestError", kind: "server", message: "pagina anonima" });
    assert.equal((await one(`SELECT company_id FROM error_logs WHERE id = ?`, [id]))?.company_id, null);
  });

  it("usuário afetado define a empresa mesmo sem escopo explícito", async () => {
    const { registrarErro } = await carregar("src/lib/error-log.ts");
    const { one } = await relativo("../src/lib/db.ts");
    sessaoAtual = null;
    const id = await registrarErro({
      source: "onRequestError",
      kind: "server",
      message: "erro do dono da ZB",
      userId: 20,
      userName: "Dono ZB",
    });
    assert.equal((await one(`SELECT company_id FROM error_logs WHERE id = ?`, [id]))?.company_id, 2);
  });
});

/* ------------------------------------------------------------------ */
/* 4. Migration 0036: coluna anulável + backfill (sem apagar dados)    */
/* ------------------------------------------------------------------ */

describe("PENDÊNCIA #07 — migration 0036", () => {
  it("company_id nasce anulável e SEM DEFAULT 1", async () => {
    const { one, run } = await relativo("../src/lib/db.ts");
    const db = (globalThis as any).__limasTestDb;
    const infos = db.sqlite.prepare(`PRAGMA table_info(error_logs)`).all() as any[];
    const coluna = infos.find((c) => c.name === "company_id");
    assert.ok(coluna, "coluna company_id não existe em error_logs");
    assert.equal(coluna.notnull, 0, "company_id continua NOT NULL (0036 não aplicada?)");
    assert.equal(
      coluna.dflt_value,
      null,
      "company_id ainda tem DEFAULT (migraria linha órfã para a empresa 1)",
    );

    // INSERT sem company_id grava NULL de verdade (não o DEFAULT 1)
    await run(
      `INSERT INTO error_logs (created_at, source, kind, message) VALUES (unixepoch(), 'cron', 'server', 'sem empresa')`,
    );
    const row = await one(`SELECT company_id FROM error_logs WHERE message = 'sem empresa'`);
    assert.equal(row.company_id, null, "INSERT sem company_id não gravou NULL");
  });

  it("backfill realinha o cron pelo context, zera o resto e é idempotente", async () => {
    const { one, run } = await relativo("../src/lib/db.ts");
    const db = (globalThis as any).__limasTestDb;

    // Linhas no formato LEGADO (todas nasceram na empresa 1 por DEFAULT)
    await run(
      `INSERT INTO error_logs (created_at, source, kind, message, user_id, context, company_id) VALUES
        (unixepoch(), 'cron', 'server', 'legada-cron-zb', NULL, '{"rotina":"fidelidade","companyId":2,"empresa":"Empresa ZB"}', 1),
        (unixepoch(), 'onRequestError', 'server', 'legada-anonima', NULL, NULL, 1),
        (unixepoch(), 'onRequestError', 'server', 'legada-orfa', 99999, NULL, 1),
        (unixepoch(), 'onRequestError', 'server', 'legada-com-dono', 10, NULL, 1),
        (unixepoch(), 'cron', 'server', 'legada-zb-intacta', NULL, NULL, 2)`,
    );

    const contar = () => Number((db.sqlite.prepare(`SELECT COUNT(*) AS n FROM error_logs`).get() as any).n);
    const antes = contar();

    const mig = fs.readFileSync(path.resolve("migrations/0036_error_logs_company_nullable.sql"), "utf8");
    db.sqlite.exec(mig); // 1ª passada
    db.sqlite.exec(mig); // 2ª passada: idempotência

    const empresaDe = async (msg: string) =>
      (await one(`SELECT company_id FROM error_logs WHERE message = ?`, [msg]))?.company_id;

    // 1) cron por empresa: volta para o dono certo (prova do context)
    assert.equal(await empresaDe("legada-cron-zb"), 2, "cron legado não realinhou pelo companyId do context");
    // 2) sem empresa comprovada → global (NULL), não mais "empresa 1"
    assert.equal(await empresaDe("legada-anonima"), null, "linha anônima legada seguiu vazando na empresa 1");
    // 3) user órfão → NULL
    assert.equal(await empresaDe("legada-orfa"), null, "user órfão legado permaneceu na empresa 1");
    // Controles: dono válido permanece na própria empresa; linha de outro tenant intacta
    assert.equal(await empresaDe("legada-com-dono"), 1, "linha com dono válido foi realinhada sem necessidade");
    assert.equal(await empresaDe("legada-zb-intacta"), 2, "backfill mexeu em linha que não era da empresa 1");

    // NADA é apagado: o rebuild copia todas as linhas
    assert.equal(contar(), antes, "0036 perdeu linhas no rebuild");
  });
});
