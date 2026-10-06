/**
 * PENDÊNCIA #02 — Isolamento de ESCRITA entre empresas (5 IDORs corrigidos).
 *
 * Cenário: empresa 1 (sessão ativa) e empresa 2 marcada com "ZB". Cada action
 * / função de escrita é chamada com o ID do OUTRO tenant e precisa:
 *   1. recusar (redirect com erro, mensagem "não encontrada" ou retorno neutro);
 *   2. NADA alterar nos dados da empresa 2 (fotografia antes/depois);
 *   3. continuar funcionando para a própria empresa (controle positivo).
 *
 * As actions REAIS do App Router são importadas fora do runtime do Next: cookie
 * da sessão, navigation e cache são scaffold mínimo; o banco é o SQLite real
 * com as migrations reais (tests/helpers/d1.ts).
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

/* ------------------------------------------------------------------ */
/* Scaffold do Next: as actions importam next/*, que exige o runtime.  */
/* ------------------------------------------------------------------ */

const SESSAO = "sess-escrita-tenant";
const carregarOriginal = (Module as any)._load;

(Module as any)._load = function (request: string) {
  if (request === "next/headers") {
    return {
      cookies: async () => ({
        get: (nome: string) => (nome === "limas_session" ? { value: SESSAO } : undefined),
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

/* ------------------------------------------------------------------ */
/* Cenário: 2 empresas, dados equivalentes, marcador ZB na empresa 2   */
/* ------------------------------------------------------------------ */

const FUTURO = new Date(Date.now() + 864e5).toISOString();

// ids do cenário
const RES_A = 100, RES_B = 200;
const PAY_A = 100, PAY_B = 200;
const DEP_A = 100, DEP_B = 200;
const ENTRY_A = 300, ENTRY_B = 400;
const REC_A = 901, REC_B = 902;
let MSG_A = 0, MSG_B = 0;

async function montarCenario() {
  const { run, insert } = await import("../src/lib/db.ts");
  const exec = (sql: string, params: any[] = []) => run(sql, params);

  await exec(`UPDATE companies SET name = 'Empresa A' WHERE id = 1`);
  await exec(`INSERT INTO companies (id, name, active) VALUES (2, 'Empresa ZB', 1)`);
  await exec(`INSERT OR IGNORE INTO stock_revision (id, revision) VALUES (1, 0), (2, 0)`);

  await exec(
    `INSERT INTO users (id, name, username, password_hash, role, company_id, active) VALUES
      (10, 'Dono A', 'dono-a-escrita', 'x', 'owner', 1, 1),
      (20, 'Dono ZB', 'dono-b-escrita', 'x', 'owner', 2, 1)`,
  );
  await exec(`INSERT INTO sessions (id, user_id, expires_at) VALUES (?, 10, ?)`, [SESSAO, FUTURO]);

  await exec(
    `INSERT INTO customers (id, name, phone, company_id) VALUES
      (100, 'Cliente Alice', '31999990000', 1), (200, 'Cliente ZB', '31999990001', 2)`,
  );
  await exec(
    `INSERT INTO reservations (id, number, customer_id, status, event_date, delivery_at, pickup_at, total_cents, company_id) VALUES
      (${RES_A}, 'LIMA-001', 100, 'confirmada', '2026-10-10', '2026-10-10T08:00', '2026-10-11T10:00', 50000, 1),
      (${RES_B}, 'ZB-001', 200, 'confirmada', '2026-10-10', '2026-10-10T08:00', '2026-10-11T10:00', 40000, 2)`,
  );
  await exec(
    `INSERT INTO payments (id, reservation_id, amount_cents, method, paid_at, company_id) VALUES
      (${PAY_A}, ${RES_A}, 50000, 'pix', '2026-10-01', 1),
      (101, NULL, 1111, 'pix', '2026-10-01', 1),
      (102, NULL, 2222, 'pix', '2026-10-01', 1),
      (${PAY_B}, ${RES_B}, 40000, 'pix', '2026-10-01', 2)`,
  );
  await exec(
    `INSERT INTO deposits (id, reservation_id, amount_cents, status, received_at, method, company_id) VALUES
      (${DEP_A}, ${RES_A}, 10000, 'recebida', '2026-10-01', 'dinheiro', 1),
      (${DEP_B}, ${RES_B}, 20000, 'recebida', '2026-10-02', 'pix', 2)`,
  );
  await exec(
    `INSERT INTO financial_entries (id, direction, origin, number, description, amount_cents, due_date, status, company_id) VALUES
      (${ENTRY_A}, 'pagar', 'despesa', 'PAG-A', 'Manutencao A', 5000, '2026-10-10', 'aberta', 1),
      (${ENTRY_B}, 'pagar', 'despesa', 'ZB-PAG', 'Manutencao ZB', 7000, '2026-10-10', 'aberta', 2)`,
  );
  // números baixos de propósito: a série RCB-001+ continua livre para as
  // emissões dos testes de controle positivo
  await exec(
    `INSERT INTO receipts (id, number, source_type, payment_id, amount_cents, paid_at, company_id) VALUES
      (${REC_A}, 'RCB-090', 'payment', 101, 1111, '2026-10-01', 1),
      (${REC_B}, 'RCB-091', 'payment', ${PAY_B}, 40000, '2026-10-01', 2)`,
  );
  // fidelity_messages nasce com company_id DEFAULT 1 (pendência #04): o
  // escopo de escrita correto é o DONO da mensagem (customers.company_id).
  MSG_A = await insert(
    `INSERT INTO fidelity_messages (customer_id, event, body, dedupe_key, status) VALUES (100, 'pos_locacao', 'Mensagem A', 'escrita:m1', 'pendente')`,
  );
  MSG_B = await insert(
    `INSERT INTO fidelity_messages (customer_id, event, body, dedupe_key, status) VALUES (200, 'pos_locacao', 'Mensagem ZB', 'escrita:m2', 'pendente')`,
  );
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const carregar = (rel: string) => import(pathToFileURL(path.resolve(rel)).href);

function fd(pares: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(pares)) f.set(k, v);
  return f;
}

/** Chama uma action e devolve a URL do NEXT_REDIRECT lançado. */
async function acao(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (msg.startsWith("NEXT_REDIRECT:")) return msg.slice("NEXT_REDIRECT:".length);
    throw e;
  }
  throw new Error("action terminou sem redirect");
}

const sql = async (s: string, p: any[] = []) => {
  const { all } = await import("../src/lib/db.ts");
  return await all<any>(s, p);
};
const um = async (s: string, p: any[] = []) => {
  const { one } = await import("../src/lib/db.ts");
  return await one<any>(s, p);
};
const esc = async (s: string, p: any[] = []) => {
  const { run } = await import("../src/lib/db.ts");
  return await run(s, p);
};
const cont = async (s: string, p: any[] = []) => {
  const { scalar } = await import("../src/lib/db.ts");
  return (await scalar<number>(s, p)) ?? 0;
};

/** Fotografia do que o IDOR poderia estragar na empresa 2. */
async function fotografiaZB() {
  return JSON.stringify({
    deposits: await sql(`SELECT * FROM deposits WHERE reservation_id = ? ORDER BY id`, [RES_B]),
    receipts: await sql(`SELECT * FROM receipts WHERE company_id = 2 ORDER BY id`),
    entries: await sql(`SELECT id, status FROM financial_entries WHERE company_id = 2 ORDER BY id`),
    msgs: await sql(`SELECT id, status FROM fidelity_messages WHERE customer_id = 200 ORDER BY id`),
    quitacoes: await sql(`SELECT * FROM receipts WHERE source_type = 'quitacao' ORDER BY id`),
  });
}

before(async () => {
  const { createTestDb, resetTestDb } = await import("./helpers/d1.ts");
  const db = await import("../src/lib/db.ts");
  resetTestDb();
  db.resetCompanyCache();
  createTestDb();
  await montarCenario();
});

/* ------------------------------------------------------------------ */
/* 1. Actions de recibos                                               */
/* ------------------------------------------------------------------ */

describe("PENDÊNCIA #02 — actions de recibos", () => {
  it("gerarReciboPayment recusa pagamento de outra empresa e não emite nada", async () => {
    const antes = await fotografiaZB();
    const total = await cont(`SELECT COUNT(*) FROM receipts`);
    const { gerarReciboPayment } = await carregar("src/app/(app)/recibos/actions.ts");
    const url = await acao(() => gerarReciboPayment(fd({ payment_id: String(PAY_B), voltar: "/financeiro" })));

    assert.match(decodeURIComponent(url), /erro=.*não encontrado/i, `redirect sem erro claro: ${url}`);
    assert.equal(await cont(`SELECT COUNT(*) FROM receipts WHERE payment_id = ?`, [PAY_B]), 1, "recibo criado para pagamento ZB");
    assert.equal(await cont(`SELECT COUNT(*) FROM receipts`), total, "a emissão criou recibo fora do escopo");
    assert.equal(await fotografiaZB(), antes, "dados da empresa 2 alterados");
  });

  it("gerarReciboPayment continua emitindo o pagamento da própria empresa", async () => {
    const { gerarReciboPayment } = await carregar("src/app/(app)/recibos/actions.ts");
    // a locação de 50000 está integralmente paga: o recibo individual E a
    // quitação são da empresa 1 (controle positivo das duas emissões)
    const url = await acao(() => gerarReciboPayment(fd({ payment_id: String(PAY_A), voltar: "/financeiro" })));
    assert.match(url, /^\/recibos\/\d+/, `redirect inesperado: ${url}`);

    const rec = await um(`SELECT * FROM receipts WHERE payment_id = ?`, [PAY_A]);
    assert.ok(rec, "recibo da própria empresa não foi emitido");
    assert.equal(rec.company_id, 1);
    const quit = await um(
      `SELECT * FROM receipts WHERE source_type = 'quitacao' AND obrigacao_tipo = 'locacao' AND obrigacao_id = ?`,
      [RES_A],
    );
    assert.ok(quit, "quitação da própria empresa não foi emitida");
    assert.equal(quit.company_id, 1);
  });

  it("gerarQuitacaoLocacao recusa reserva de outra empresa", async () => {
    const antes = await fotografiaZB();
    const { gerarQuitacaoLocacao } = await carregar("src/app/(app)/recibos/actions.ts");
    const url = await acao(() => gerarQuitacaoLocacao(fd({ reservation_id: String(RES_B) })));

    assert.match(decodeURIComponent(url), /aviso=.*Reserva não encontrada/, `redirect inesperado: ${url}`);
    assert.equal(
      await cont(`SELECT COUNT(*) FROM receipts WHERE source_type = 'quitacao' AND obrigacao_id = ?`, [RES_B]),
      0,
      "quitação criada para reserva ZB",
    );
    assert.equal(await fotografiaZB(), antes, "dados da empresa 2 alterados");
  });

  it("excluirReciboAction não exclui recibo de outra empresa", async () => {
    const { excluirReciboAction } = await carregar("src/app/(app)/recibos/actions.ts");
    await acao(() => excluirReciboAction(fd({ receipt_id: String(REC_B), voltar: "/financeiro" })));

    const rec = await um(`SELECT * FROM receipts WHERE id = ?`, [REC_B]);
    assert.ok(rec, "recibo ZB foi excluído por sessão de outra empresa");
    assert.equal(rec.company_id, 2);
  });

  it("excluirReciboAction continua excluindo o recibo da própria empresa", async () => {
    const { excluirReciboAction } = await carregar("src/app/(app)/recibos/actions.ts");
    await acao(() => excluirReciboAction(fd({ receipt_id: String(REC_A), voltar: "/financeiro" })));
    assert.equal(await cont(`SELECT COUNT(*) FROM receipts WHERE id = ?`, [REC_A]), 0);
  });
});

/* ------------------------------------------------------------------ */
/* 2. Funções de escrita da lib (companyId explícito = ator)           */
/* ------------------------------------------------------------------ */

describe("PENDÊNCIA #02 — emissão e exclusão de recibos na lib", () => {
  it("emitirRecibo recusa pagamento/caução de outra empresa", async () => {
    const antes = await fotografiaZB();
    const total = await cont(`SELECT COUNT(*) FROM receipts`);
    const { emitirRecibo } = await carregar("src/lib/recibos.ts");

    const p = await emitirRecibo({ tipo: "payment", paymentId: PAY_B }, { companyId: 1 });
    assert.match(p.erro ?? "", /não encontrado/i);
    assert.equal(p.receiptId, undefined);

    const d = await emitirRecibo({ tipo: "deposit", depositId: DEP_B }, { companyId: 1 });
    assert.match(d.erro ?? "", /não encontrada/i);

    assert.equal(await fotografiaZB(), antes, "empresa 2 alterada pela emissão");
    assert.equal(await cont(`SELECT COUNT(*) FROM receipts`), total, "recibo criado fora do escopo");
  });

  it("emitirRecibo emite normalmente para a própria empresa (controle positivo)", async () => {
    const { emitirRecibo } = await carregar("src/lib/recibos.ts");
    const r = await emitirRecibo({ tipo: "deposit", depositId: DEP_A }, { companyId: 1 });
    assert.equal(r.erro, null);
    const rec = await um(`SELECT * FROM receipts WHERE deposit_id = ?`, [DEP_A]);
    assert.ok(rec);
    assert.equal(rec.company_id, 1);
  });

  it("excluirRecibo devolve false para recibo de outra empresa", async () => {
    const { excluirRecibo } = await carregar("src/lib/recibos.ts");
    assert.equal(await excluirRecibo(REC_B, 1), false);
    assert.ok(await um(`SELECT id FROM receipts WHERE id = ?`, [REC_B]), "recibo ZB apagado");

    // controle positivo: um recibo novo, da empresa 1, sai normalmente
    const { insert } = await import("../src/lib/db.ts");
    const novo = await insert(
      `INSERT INTO receipts (number, source_type, payment_id, amount_cents, paid_at, company_id) VALUES ('RCB-099','payment',102,2222,'2026-10-01',1)`,
    );
    assert.equal(await excluirRecibo(novo, 1), true);
    assert.equal(await cont(`SELECT COUNT(*) FROM receipts WHERE id = ?`, [novo]), 0);
  });

  it("emitirQuitacao recusa reserva de outra empresa (locação e caução)", async () => {
    const antes = await fotografiaZB();
    const quitacoes = await cont(`SELECT COUNT(*) FROM receipts WHERE source_type = 'quitacao'`);
    const { emitirQuitacao } = await carregar("src/lib/recibos.ts");

    const l = await emitirQuitacao("locacao", RES_B, { companyId: 1 });
    assert.match(l.erro ?? "", /Reserva não encontrada/);
    const c = await emitirQuitacao("caucao", RES_B, { companyId: 1 });
    assert.match(c.erro ?? "", /Reserva não encontrada/);

    assert.equal(await fotografiaZB(), antes, "empresa 2 alterada pela quitação");
    assert.equal(
      await cont(`SELECT COUNT(*) FROM receipts WHERE source_type = 'quitacao'`),
      quitacoes,
      "quitação criada fora do escopo",
    );
  });

  it("emitirQuitacaoSeQuitada é neutro para lançamento de outra empresa", async () => {
    const antes = await fotografiaZB();
    const quitacoes = await cont(`SELECT COUNT(*) FROM receipts WHERE source_type = 'quitacao'`);
    const { emitirQuitacaoSeQuitada } = await carregar("src/lib/recibos.ts");

    const p = await emitirQuitacaoSeQuitada({ tipo: "payment", paymentId: PAY_B }, { companyId: 1 });
    assert.equal(p.erro, null);
    assert.equal(p.criado, undefined);
    const d = await emitirQuitacaoSeQuitada({ tipo: "deposit", depositId: DEP_B }, { companyId: 1 });
    assert.equal(d.erro, null);

    assert.equal(await fotografiaZB(), antes, "empresa 2 alterada pelo gatilho de quitação");
    assert.equal(await cont(`SELECT COUNT(*) FROM receipts WHERE source_type = 'quitacao'`), quitacoes);
  });
});

/* ------------------------------------------------------------------ */
/* 3. Cancelamento de conta a pagar                                    */
/* ------------------------------------------------------------------ */

describe("PENDÊNCIA #02 — cancelarContaPagarManual", () => {
  it("recusa cancelar conta manual de outra empresa", async () => {
    const { cancelarContaPagarManual } = await carregar("src/lib/pagar.ts");
    const erro = await cancelarContaPagarManual(ENTRY_B, 1);
    assert.match(erro ?? "", /não encontrada/);

    const entry = await um(`SELECT status FROM financial_entries WHERE id = ?`, [ENTRY_B]);
    assert.equal(entry.status, "aberta", "conta ZB foi cancelada por sessão de outra empresa");
  });

  it("continua cancelando a conta manual da própria empresa (controle positivo)", async () => {
    const { cancelarContaPagarManual } = await carregar("src/lib/pagar.ts");
    const erro = await cancelarContaPagarManual(ENTRY_A, 1);
    assert.equal(erro, null);
    const entry = await um(`SELECT status FROM financial_entries WHERE id = ?`, [ENTRY_A]);
    assert.equal(entry.status, "cancelada");
  });
});

/* ------------------------------------------------------------------ */
/* 4. Caução (saveDeposit) e fila de fidelidade (marcarMensagem)       */
/* ------------------------------------------------------------------ */

describe("PENDÊNCIA #02 — actions de caução e fidelidade", () => {
  it("saveDeposit recusa gravar caução em reserva de outra empresa", async () => {
    const antes = await fotografiaZB();
    const { saveDeposit } = await carregar("src/app/(app)/reservas/actions.ts");

    const url = await acao(() =>
      saveDeposit(
        fd({
          reservation_id: String(RES_B),
          amount: "999,00",
          status: "recebida",
          method: "pix",
          received_at: "2026-10-05",
          retained: "0",
          reason: "",
        }),
      ),
    );
    assert.equal(url, "/reservas", `redirect inesperado: ${url}`);
    assert.equal(await fotografiaZB(), antes, "caução da reserva ZB foi alterada");
  });

  it("saveDeposit continua gravando a caução da própria empresa (controle positivo)", async () => {
    const { saveDeposit } = await carregar("src/app/(app)/reservas/actions.ts");
    await saveDeposit(
      fd({
        reservation_id: String(RES_A),
        amount: "150,00",
        status: "recebida",
        method: "pix",
        received_at: "2026-10-05",
        retained: "0",
        reason: "",
      }),
    );
    const dep = await um(`SELECT * FROM deposits WHERE id = ?`, [DEP_A]);
    assert.equal(dep.amount_cents, 15000);
    assert.equal(dep.company_id, 1);
  });

  it("marcarMensagem não marca mensagem de cliente de outra empresa", async () => {
    const { marcarMensagem } = await carregar("src/app/(app)/fidelidade/actions.ts");

    await marcarMensagem(fd({ id: String(MSG_B), status: "enviada" }));
    const zb = await um(`SELECT status FROM fidelity_messages WHERE id = ?`, [MSG_B]);
    assert.equal(zb.status, "pendente", "mensagem do cliente ZB foi marcada por sessão de outra empresa");

    await marcarMensagem(fd({ id: String(MSG_A), status: "enviada" }));
    const a = await um(`SELECT status FROM fidelity_messages WHERE id = ?`, [MSG_A]);
    assert.equal(a.status, "enviada", "mensagem da própria empresa deixou de funcionar");
  });
});
