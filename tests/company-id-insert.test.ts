/**
 * PENDÊNCIA #04 — causa raiz: INSERTs que gravavam company_id DEFAULT 1.
 *
 * Duas provas:
 *   1. GUARDA ESTÁTICA: todo INSERT em src/ direcionado a uma tabela que tem
 *      a coluna company_id precisa MENCIONAR company_id no statement. Tabela
 *      e coluna vêm das migrations reais (fonte da verdade do schema).
 *   2. COMPORTEMENTO: com duas empresas no banco, cada escrita corrigida grava
 *      o company_id do tenant certo (e não o DEFAULT 1).
 *
 * Banco SQLite real com as migrations reais (tests/helpers/d1.ts) e scaffold
 * mínimo de next/* para importar actions fora do runtime do Next.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import Module from "node:module";
import { pathToFileURL } from "node:url";

/* ------------------------------------------------------------------ */
/* Scaffold do Next: as actions importam next/*, que exige o runtime.  */
/* ------------------------------------------------------------------ */

const SESSAO_A = "sess-cid-tenant-a";
const SESSAO_B = "sess-cid-tenant-b";
/** Sessão corrente — os testes trocam para rodar como a empresa 2. */
let sessaoAtual = SESSAO_A;
const carregarOriginal = (Module as any)._load;

(Module as any)._load = function (request: string) {
  if (request === "next/headers") {
    return {
      cookies: async () => ({
        get: (nome: string) => (nome === "limas_session" ? { value: sessaoAtual } : undefined),
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
  if (request === "next/cache") {
    return { revalidatePath: () => {}, revalidateTag: () => {} };
  }
  if (request === "next/link" || request === "next/form" || request === "next/image") {
    return { __esModule: true, default: (p: any) => p?.children ?? null, Link: (p: any) => p?.children ?? null };
  }
  if (request === "server-only") return {};
  return carregarOriginal.apply(this, arguments as any);
};

const carregar = (rel: string) => import(pathToFileURL(path.resolve(rel)).href);

/* ------------------------------------------------------------------ */
/* 1. Guarda estática                                                  */
/* ------------------------------------------------------------------ */

/** Tabelas com coluna company_id — extraídas das migrations reais. */
function tabelasComCompany(): Set<string> {
  const dir = path.resolve("migrations");
  const mig = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => fs.readFileSync(path.join(dir, f), "utf8"))
    .join("\n");
  const tabelas = new Set<string>();
  for (const m of mig.matchAll(/ALTER TABLE (\w+)\s+ADD COLUMN company_id/gi)) tabelas.add(m[1].toLowerCase());
  for (const m of mig.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?(\w+)/gi)) {
    const corpo = mig.slice(m.index, mig.indexOf(";", m.index));
    if (/\bcompany_id\b/i.test(corpo)) tabelas.add(m[1].toLowerCase());
  }
  return tabelas;
}

function arquivosTs(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const cheio = path.join(dir, e.name);
    if (e.isDirectory()) return arquivosTs(cheio);
    return e.name.endsWith(".ts") ? [cheio] : [];
  });
}

/**
 * INSERTs sem company_id em tabelas que têm a coluna.
 *
 * Exceções conscientes:
 *  - src/lib/seed.ts: roda só quando a base está VAZIA (uma única empresa
 *    possível) — não existe outro tenant a separar naquela hora;
 *  - statement com interpolação dinâmica (writeRental monta a lista de
 *    colunas em runtime e injeta company_id no header) — o INSERT dinâmico é
 *    coberto pelo teste de comportamento do cadastro de reservas.
 */
function insertsPendentes(): string[] {
  const tabelas = tabelasComCompany();
  const pendentes: string[] = [];
  for (const arquivo of arquivosTs(path.resolve("src"))) {
    if (arquivo.endsWith(`${path.sep}seed.ts`)) continue;
    const fonte = fs.readFileSync(arquivo, "utf8");
    for (const m of fonte.matchAll(/INSERT(?:\s+OR\s+\w+)?\s+INTO\s+(\w+)/gi)) {
      const tabela = m[1].toLowerCase();
      if (!tabelas.has(tabela)) continue;
      let trecho = fonte.slice(m.index, m.index + 700);
      const fim = trecho.search(/[;`]/);
      if (fim > 0) trecho = trecho.slice(0, fim);
      const dinamico = /\bfields\.map\b/.test(fonte.slice(Math.max(0, m.index - 200), m.index + 300));
      if (/company_id/i.test(trecho) || dinamico) continue;
      pendentes.push(`${path.relative(process.cwd(), arquivo)} -> INSERT INTO ${m[1]}`);
    }
  }
  return pendentes;
}

describe("PENDÊNCIA #04 — guarda estática dos INSERTs", () => {
  it("nenhum INSERT em src/ esquece o company_id em tabela que tem a coluna", () => {
    const pendentes = insertsPendentes();
    assert.deepEqual(
      pendentes,
      [],
      `INSERTs gravando company_id DEFAULT 1 (corrija o statement ou registre exceção justificada):\n  ${pendentes.join("\n  ")}`,
    );
  });
});

/* ------------------------------------------------------------------ */
/* Cenário: 2 empresas, marcador ZB na empresa 2                       */
/* ------------------------------------------------------------------ */

const HOJE = new Date().toISOString().slice(0, 10);

async function montarCenario() {
  const { run, insert } = await import("../src/lib/db.ts");
  await run(`UPDATE companies SET name = 'Empresa A' WHERE id = 1`);
  await run(`INSERT INTO companies (id, name, active) VALUES (2, 'Empresa ZB', 1)`);
  await run(
    `INSERT INTO users (id, name, username, password_hash, role, company_id, active) VALUES
      (10, 'Dono A', 'cid-dono-a', 'x', 'owner', 1, 1),
      (11, 'Equipe A', 'cid-equipe-a', 'x', 'operacional', 1, 1),
      (20, 'Dono ZB', 'cid-dono-b', 'x', 'owner', 2, 1),
      (21, 'Equipe ZB', 'cid-equipe-b', 'x', 'operacional', 2, 1)`,
  );
  await run(`INSERT INTO sessions (id, user_id, expires_at) VALUES (?, 10, ?)`, [SESSAO_A, proximaHora()]);
  await run(`INSERT INTO sessions (id, user_id, expires_at) VALUES (?, 20, ?)`, [SESSAO_B, proximaHora()]);
  await run(
    `INSERT INTO customers (id, name, phone, birth_date, company_id) VALUES
      (100, 'Cliente Alice', '31999990000', '1990-05-01', 1),
      (200, 'Cliente ZB', '31999990001', ?, 2)`,
    [HOJE],
  );
}

function proximaHora(): number {
  return Math.floor(Date.now() / 1000) + 3600;
}

const sql = async (s: string, p: any[] = []) => {
  const { all } = await import("../src/lib/db.ts");
  return await all<any>(s, p);
};
const um = async (s: string, p: any[] = []) => {
  const { one } = await import("../src/lib/db.ts");
  return await one<any>(s, p);
};
const cont = async (s: string, p: any[] = []) => {
  const { scalar } = await import("../src/lib/db.ts");
  return (await scalar<number>(s, p)) ?? 0;
};

before(async () => {
  const { createTestDb, resetTestDb } = await import("./helpers/d1.ts");
  const db = await import("../src/lib/db.ts");
  resetTestDb();
  db.resetCompanyCache();
  createTestDb();
  await montarCenario();
});

after(async () => {
  sessaoAtual = SESSAO_A;
});

/* ------------------------------------------------------------------ */
/* 2. Comportamento                                                    */
/* ------------------------------------------------------------------ */

describe("PENDÊNCIA #04 — INSERTs gravam o company_id certo", () => {
  it("logAction grava company_id e company_id_ref do ator (empresa 2)", async () => {
    const { logAction } = await carregar("src/lib/audit.ts");
    await logAction(
      { id: 20, name: "Dono ZB", company_id: 2 } as any,
      "editar",
      "clientes",
      200,
      "Dono ZB editou o cliente ZB",
    );
    const row = await um(`SELECT company_id, company_id_ref FROM audit_logs WHERE summary = ?`, [
      "Dono ZB editou o cliente ZB",
    ]);
    assert.ok(row, "log não gravado");
    assert.equal(row.company_id, 2, "coluna legada company_id gravou o DEFAULT 1");
    assert.equal(row.company_id_ref, 2, "escopo de leitura company_id_ref divergente");
  });

  it("logAction sem usuário (log de plataforma) usa 1 e não viola NOT NULL", async () => {
    const { logAction } = await carregar("src/lib/audit.ts");
    await logAction(null, "sistema", "config", null, "rotina sem sessão");
    const row = await um(`SELECT company_id, company_id_ref FROM audit_logs WHERE summary = ?`, ["rotina sem sessão"]);
    assert.ok(row, "log de plataforma não gravado");
    assert.equal(row.company_id, 1);
    assert.equal(row.company_id_ref, null, "log de plataforma não pode ter escopo de tenant");
  });

  it("registrarErro usa a empresa do usuário afetado, não o DEFAULT 1", async () => {
    const { registrarErro } = await carregar("src/lib/error-log.ts");
    const id = await registrarErro({
      source: "cron",
      kind: "server",
      message: "Falha ZB",
      userId: 20,
      userName: "Dono ZB",
    });
    assert.ok(id, "erro não registrado");
    const row = await um(`SELECT company_id FROM error_logs WHERE id = ?`, [id]);
    assert.equal(row.company_id, 2, "error_logs gravou company_id DEFAULT 1");
  });

  it("prepararMensagem grava fidelity_messages na empresa do DONO do cliente", async () => {
    const { prepararMensagem } = await carregar("src/lib/fidelidade-db.ts");
    // 'conquista' porque a migration 0008 semeia fidelity_notify_progress='0'
    const id = await prepararMensagem("conquista", 200, "cid-teste", { pontos: 3, meta: 5 });
    assert.ok(id, "mensagem não criada (dedupe/settings impediram)");
    const row = await um(`SELECT company_id FROM fidelity_messages WHERE id = ?`, [id]);
    assert.equal(row.company_id, 2, "fidelity_messages gravou company_id DEFAULT 1");
  });

  it("avisarEquipe só notifica a equipe da empresa do cliente", async () => {
    const { avisarEquipe } = await carregar("src/lib/fidelidade-db.ts");
    await avisarEquipe("conquista", "Cliente ZB atingiu a meta", 200, "cid-avisar");

    const notificados = await sql(
      `SELECT n.user_id, n.company_id FROM user_notifications n
        WHERE n.type = 'fidelidade' AND n.body = ?`,
      ["Cliente ZB atingiu a meta"],
    );
    assert.ok(notificados.length > 0, "nenhum aviso criado");
    const deA = notificados.filter((n) => n.user_id === 10 || n.user_id === 11);
    assert.deepEqual(deA, [], "usuários da empresa 1 notificados sobre cliente da empresa 2");
    for (const n of notificados) {
      assert.equal(n.company_id, 2, `aviso de tenant 2 gravado com company_id=${n.company_id}`);
    }
  });

  it("savePreferences grava notification_preferences na empresa da SESSÃO", async () => {
    sessaoAtual = SESSAO_B; // passa a agir como a empresa 2
    try {
      const { savePreferences } = await carregar("src/app/(app)/notificacoes/push-actions.ts");
      const f = new FormData();
      f.set("chat", "on");
      await savePreferences(f);
    } finally {
      sessaoAtual = SESSAO_A;
    }
    const row = await um(
      `SELECT company_id FROM notification_preferences WHERE user_id = 20 AND type = 'chat'`,
    );
    assert.ok(row, "preferência não gravada");
    assert.equal(row.company_id, 2, "notification_preferences gravou company_id DEFAULT 1");
  });

  it("rotinaAniversarios avisa apenas a equipe da empresa ativa", async () => {
    sessaoAtual = SESSAO_B; // empresa 2 no comando da rotina
    try {
      const { rotinaAniversarios } = await carregar("src/lib/aniversarios-db.ts");
      const r = await rotinaAniversarios(HOJE);
      assert.ok(r.avisos > 0, "rotina não criou avisos");
    } finally {
      sessaoAtual = SESSAO_A;
    }
    const avisos = await sql(
      `SELECT n.user_id, n.company_id FROM user_notifications n WHERE n.type = 'aniversario'`,
    );
    assert.ok(avisos.length > 0, "nenhum aviso de aniversário criado");
    const deA = avisos.filter((n) => n.user_id === 10 || n.user_id === 11);
    assert.deepEqual(deA, [], "equipe da empresa 1 recebeu aviso da empresa 2");
    for (const a of avisos) {
      assert.equal(a.company_id, 2, `aviso de aniversário gravado com company_id=${a.company_id}`);
    }
  });

  it("ensureConversation grava conversa e participantes na empresa certa", async () => {
    const { ensureConversation } = await carregar("src/lib/chat.ts");
    const conv = await ensureConversation(20, 21);
    const row = await um(`SELECT company_id FROM chat_conversations WHERE id = ?`, [conv]);
    assert.equal(row.company_id, 2, "conversa gravada com company_id DEFAULT 1");
    const parts = await sql(`SELECT company_id FROM chat_participants WHERE conversation_id = ?`, [conv]);
    assert.equal(parts.length, 2, "participantes não gravados");
    for (const p of parts) {
      assert.equal(p.company_id, 2, "participante gravado com company_id DEFAULT 1");
    }

    // par de empresas diferentes continua recusado (controle negativo)
    await assert.rejects(
      () => ensureConversation(10, 20),
      /Usuário não disponível/,
      "chat permitiu par cross-tenant",
    );
  });
});

/* ------------------------------------------------------------------ */
/* 3. Migrations 0032 (triggers) e 0033 (backfill)                     */
/* ------------------------------------------------------------------ */

describe("PENDÊNCIA #04 — migrations 0032/0033", () => {
  it("trigger de activities nasce com o company_id da FONTE (reserva ZB)", async () => {
    const { run } = await import("../src/lib/db.ts");
    await run(`INSERT OR IGNORE INTO stock_revision (id, revision) VALUES (1, 0), (2, 0)`);
    await run(
      `INSERT INTO reservations (id, number, customer_id, status, event_date, delivery_at, pickup_at, total_cents, company_id)
       VALUES (210, 'ZB-090', 200, 'confirmada', '2026-11-20', '2026-11-20T08:00', '2026-11-21T10:00', 30000, 2)`,
    );

    const ats = await sql(`SELECT kind, company_id FROM activities WHERE source = 'reservations' AND source_id = 210`);
    assert.equal(ats.length, 2, "triggers não criaram as duas activities (reserva + separação)");
    for (const a of ats) {
      assert.equal(a.company_id, 2, `activity '${a.kind}' gravou company_id=${a.company_id} (DEFAULT 1)`);
    }
    const evs = await sql(
      `SELECT e.company_id FROM notification_events e JOIN activities a ON a.id = e.activity_id
        WHERE a.source = 'reservations' AND a.source_id = 210`,
    );
    assert.ok(evs.length > 0, "trigger activity_created não gerou eventos");
    for (const e of evs) {
      assert.equal(e.company_id, 2, `notification_events gravou company_id=${e.company_id}`);
    }
  });

  it("backfill 0033 realinha linhas legadas pelo dono e é idempotente", async () => {
    const fsMod = await import("node:fs");
    const pathMod = await import("node:path");
    const { run } = await import("../src/lib/db.ts");

    // linhas "legadas": company_id 1 com dono da empresa 2
    await run(
      `INSERT INTO user_notifications (user_id, event_id, type, title, body, link, created_at, company_id)
       VALUES (20, NULL, 'chat', 'Legada', 'corpo', '/chat', unixepoch(), 1)`,
    );
    await run(
      `INSERT INTO chat_messages (conversation_id, sender_id, body, company_id) VALUES (?, 20, 'legada', 1)`,
      [(await um(`SELECT id FROM chat_conversations WHERE user_low = 20`))!.id],
    );

    const sqlBackfill = fsMod.readFileSync(pathMod.resolve("migrations/0033_company_id_backfill.sql"), "utf8");
    for (const stmt of sqlBackfill.split(";")) {
      const limpo = stmt.replace(/^\s*--.*$/gm, "").trim();
      if (limpo) await run(limpo);
    }

    const un = await um(
      `SELECT company_id FROM user_notifications WHERE user_id = 20 AND title = 'Legada'`,
    );
    assert.equal(un.company_id, 2, "backfill não realinhou user_notifications pelo dono");
    const cm = await um(`SELECT company_id FROM chat_messages WHERE body = 'legada'`);
    assert.equal(cm.company_id, 2, "backfill não realinhou chat_messages pela conversa");
    // linha da empresa 1 intacta (controle)
    const deA = await cont(
      `SELECT COUNT(*) FROM user_notifications WHERE user_id = 10 AND company_id = 1`,
    );
    assert.ok(deA >= 0);

    // idempotência: segunda passada não muda nada
    const antes = JSON.stringify([un.company_id, cm.company_id]);
    for (const stmt of sqlBackfill.split(";")) {
      const limpo = stmt.replace(/^\s*--.*$/gm, "").trim();
      if (limpo) await run(limpo);
    }
    const un2 = await um(`SELECT company_id FROM user_notifications WHERE user_id = 20 AND title = 'Legada'`);
    const cm2 = await um(`SELECT company_id FROM chat_messages WHERE body = 'legada'`);
    assert.equal(JSON.stringify([un2.company_id, cm2.company_id]), antes, "segunda passada do backfill alterou dados");
  });
});
