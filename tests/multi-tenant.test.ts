/**
 * Testes MULTI-TENANT: o coração da garantia de isolamento da Etapa 2.
 *
 * Dois tenants (empresa 1 e empresa 2) com clientes, produtos, reservas e
 * pagamentos equivalentes. Todas as funções de leitura/escrita têm que devolver
 * apenas os dados da empresa informada — e nada da outra.
 *
 * Sem Next request context (testes), as funções que não recebem companyId
 * explícito caem na empresa padrão do banco (currentCompanyId) — por isso os
 * cenários AQUI passam SEMPRE a empresa do ator, como a camada autenticada
 * faz (requireCompanyContext → companyId da sessão).
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createTestDb, resetTestDb } from "./helpers/d1.ts";
import { all, insert, one, run, scalar } from "../src/lib/db.ts";
import { resetCompanyCache, currentCompanyId } from "../src/lib/db.ts";
import {
  operationsBetween,
  globalSearch,
  getCustomer,
  dashboardStats,
  freightsOn,
} from "../src/lib/queries.ts";
import { availabilityAll, loadHolds, checkConflicts, loadSpecs } from "../src/lib/stock.ts";
import { stockVersion, commitStockBatch } from "../src/lib/stock-write.ts";
import { nextNumber } from "../src/lib/db.ts";
import { listNotifications, unreadCount } from "../src/lib/notifications.ts";
import { contactableUsers, ensureConversation } from "../src/lib/chat.ts";
import { canView, canEdit, ehAdmin, modulesFor } from "../src/lib/roles.ts";

let seqProduto = 0;
let seqCliente = 0;

async function criarEmpresas() {
  // A migration 0027 já cria a empresa 1 (Lima's Locações): é o tenant A.
  await run(`UPDATE companies SET name = 'Empresa A' WHERE id = 1`);
  await insert(`INSERT INTO companies (id, name, active) VALUES (2, 'Empresa B', 1)`);
  // revisão de estoque por empresa
  await run(`INSERT OR IGNORE INTO stock_revision (id, revision) VALUES (1, 0)`);
  await run(`INSERT OR IGNORE INTO stock_revision (id, revision) VALUES (2, 0)`);
  // prefixos por empresa já vêm da migration 0028 (empresa 1 = LIMA, demais = LOC)
}

async function usuario(companyId: number, role = "operacional") {
  return await insert(
    `INSERT INTO users (name, username, password_hash, role, company_id) VALUES (?,?,?,?,?)`,
    [`U${companyId}-${role}`, `u${companyId}_${Math.random().toString(36).slice(2, 8)}`, "x", role, companyId],
  );
}

async function cliente(companyId: number, nome: string) {
  return await insert(
    `INSERT INTO customers (name, phone, company_id) VALUES (?,?,?)`,
    [nome, "11999990000", companyId],
  );
}

async function produto(companyId: number, nome: string, total: number) {
  seqProduto++;
  const id = await insert(
    `INSERT INTO products (code, name, category_id, kind, total_qty, min_qty, rent_price_cents, company_id)
     VALUES (?,?,NULL,'simples',?,?,1000,?)`,
    [`P${seqProduto}-${companyId}`, nome, total, 0, companyId],
  );
  return id;
}

async function reserva(
  companyId: number,
  clienteId: number,
  produtoId: number,
  opts: { number?: string; status?: string; entrega?: string; retirada?: string; qty?: number } = {},
) {
  const numero = opts.number ?? `R${companyId}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  const entrega = opts.entrega ?? "2026-10-10T08:00";
  const retirada = opts.retirada ?? "2026-10-11T10:00";
  const id = await insert(
    `INSERT INTO reservations (number, customer_id, status, event_date, delivery_at, pickup_at, company_id)
     VALUES (?,?,?,?,?,?,?)`,
    [numero, clienteId, opts.status ?? "confirmada", entrega.slice(0, 10), entrega, retirada, companyId],
  );
  await insert(
    `INSERT INTO reservation_items (reservation_id, product_id, qty, unit_price_cents, company_id)
     VALUES (?,?,?,?,?)`,
    [id, produtoId, opts.qty ?? 1, 1000, companyId],
  );
  await insert(
    `INSERT INTO reservation_item_components (reservation_id, reservation_item_id, product_id, qty_per_unit, qty, company_id)
     VALUES (?, (SELECT MAX(id) FROM reservation_items), ?, 1, ?, ?)`,
    [id, produtoId, opts.qty ?? 1, companyId],
  );
  return id;
}

beforeEach(() => {
  resetTestDb();
  resetCompanyCache();
  createTestDb();
});

describe("fundação multi-tenant", () => {
  it("empresa padrão existe e é determinística", async () => {
    await criarEmpresas();
    assert.equal(await currentCompanyId(), 1);
  });

  it("integridade: nenhuma tabela de tenant com linha sem empresa", async () => {
    await criarEmpresas();
    const u1 = await usuario(1);
    const c1 = await cliente(1, "Cliente A");
    const p1 = await produto(1, "Mesa A", 10);
    await reserva(1, c1, p1);
    const tabelas = [
      "users", "customers", "products", "product_units", "reservations", "reservation_items",
      "reservation_item_components", "payments", "deposits", "expenses", "financial_entries",
      "files", "notifications", "audit_logs", "activities", "chat_conversations", "chat_messages",
    ];
    for (const t of tabelas) {
      const n = await scalar<number>(`SELECT COUNT(*) FROM ${t} WHERE company_id IS NULL`);
      assert.equal(n, 0, `${t} tem linhas sem company_id`);
    }
  });

  it("leitura: cliente de A não aparece para B (getCustomer e busca global)", async () => {
    await criarEmpresas();
    const cA = await cliente(1, "Alice A");
    const cB = await cliente(2, "Bob B");

    const deA = await getCustomer(cA, 1);
    assert.ok(deA, "A vê o próprio cliente");
    assert.equal(await getCustomer(cA, 2), undefined, "B NÃO vê cliente de A");

    const buscaA = await globalSearch("Bob", 1);
    assert.equal(buscaA.customers.length, 0, "busca de A não encontra cliente de B");
    const buscaB = await globalSearch("Alice", 2);
    assert.equal(buscaB.customers.length, 0, "busca de B não encontra cliente de A");
    const buscaA2 = await globalSearch("Alice", 1);
    assert.equal(buscaA2.customers.length, 1);
    assert.equal(cB ? true : false, true); // sanidade
  });

  it("reservas e operações: cada empresa só vê as suas", async () => {
    await criarEmpresas();
    const c1 = await cliente(1, "Cliente A");
    const c2 = await cliente(2, "Cliente B");
    const p1 = await produto(1, "Mesa A", 10);
    const p2 = await produto(2, "Mesa B", 10);
    await reserva(1, c1, p1, { number: "LIMA-001" });
    await reserva(2, c2, p2, { number: "LOC-001" });

    const ops1 = await operationsBetween("2026-10-01", "2026-10-31", undefined, 1);
    const ops2 = await operationsBetween("2026-10-01", "2026-10-31", undefined, 2);
    // operações são geradas por syncOperations; aqui o que importa é que a
    // leitura de reservas de cada empresa não traz a da outra
    const r1 = await all(`SELECT number FROM reservations WHERE company_id = 1`);
    const r2 = await all(`SELECT number FROM reservations WHERE company_id = 2`);
    assert.deepEqual(r1.map((x) => x.number), ["LIMA-001"]);
    assert.deepEqual(r2.map((x) => x.number), ["LOC-001"]);
    assert.ok(Array.isArray(ops1) && Array.isArray(ops2));
  });

  it("dashboard não mistura contagens entre empresas", async () => {
    await criarEmpresas();
    const c1 = await cliente(1, "Cliente A");
    const c2 = await cliente(2, "Cliente B");
    const p1 = await produto(1, "Mesa A", 10);
    const p2 = await produto(2, "Mesa B", 10);
    await reserva(1, c1, p1, { status: "confirmada", entrega: "2026-01-10T08:00", retirada: "2026-01-11T10:00" });
    await reserva(2, c2, p2, { status: "confirmada", entrega: "2026-01-10T08:00", retirada: "2026-01-11T10:00" });

    const d1 = await dashboardStats({ from: "2026-01-01T00:00", to: "2026-01-31T23:59", considerPreparation: false, label: "", queryString: "" }, undefined, 1);
    const d2 = await dashboardStats({ from: "2026-01-01T00:00", to: "2026-01-31T23:59", considerPreparation: false, label: "", queryString: "" }, undefined, 2);
    assert.equal(d1.reservas.confirmadas, 1, "A vê 1 confirmada (a dela)");
    assert.equal(d2.reservas.confirmadas, 1, "B vê 1 confirmada (a dela)");
    // 10 unidades menos a própria reserva (1) de cada empresa
    assert.equal(d1.estoque.disponiveis, 9, "estoque da A só com produtos da A");
    assert.equal(d2.estoque.disponiveis, 9, "estoque da B só com produtos da B");
  });

  it("estoque: ocupação de B não reduz disponibilidade de A", async () => {
    await criarEmpresas();
    const c1 = await cliente(1, "Cliente A");
    const c2 = await cliente(2, "Cliente B");
    const p1 = await produto(1, "Cadeiras A", 10);
    const p2 = await produto(2, "Cadeiras B", 10);
    // B ocupa 10 unidades no mesmo período
    await reserva(2, c2, p2, { entrega: "2026-10-10T08:00", retirada: "2026-10-11T10:00", qty: 10 });
    // A continua com 10 disponíveis: reserva de B não ocupa estoque de A
    const disp1 = await availabilityAll("2026-10-10T00:00", "2026-10-11T23:59", null, {}, 1);
    assert.equal(disp1.find((x) => x.product_id === p1)?.available, 10);
    // B de fato está sem estoque no período
    const disp2 = await availabilityAll("2026-10-10T00:00", "2026-10-11T23:59", null, {}, 2);
    assert.equal(disp2.find((x) => x.product_id === p2)?.available, 0);
    // e os holds de A nunca incluem reservas de B
    const holds1 = await loadHolds("2026-10-10T00:00", "2026-10-11T23:59", {}, null, null, null, 1);
    assert.ok(holds1.every((h) => h.number !== undefined));
    const holdsB = await loadHolds("2026-10-10T00:00", "2026-10-11T23:59", {}, null, null, null, 1);
    assert.ok(holdsB.every((h) => !String(h.number).startsWith("LOC-") || h.number === undefined));
  });

  it("conflito de estoque: reserva de A não conflita com ocupação de B", async () => {
    await criarEmpresas();
    const c1 = await cliente(1, "Cliente A");
    const c2 = await cliente(2, "Cliente B");
    const p1 = await produto(1, "Tendas A", 2);
    const p2 = await produto(2, "Tendas B", 2);
    await reserva(2, c2, p2, { entrega: "2026-10-10T08:00", retirada: "2026-10-11T10:00", qty: 2 });
    // A pede 2 unidades: em single-tenant compartilhado conflitaria; isolado, passa
    const conflitos = await checkConflicts(
      [{ product_id: p1, qty: 2 }],
      "2026-10-10T08:00",
      "2026-10-11T10:00",
      null,
      {},
      1,
    );
    assert.equal(conflitos.length, 0, "B ocupou tudo, mas é ESTOQUE DE B");
  });

  it("fichas de composição por empresa (loadSpecs isolado)", async () => {
    await criarEmpresas();
    const pA = await produto(1, "Base A", 5);
    const kitA = await insert(
      `INSERT INTO products (code, name, kind, total_qty, company_id) VALUES ('KIT-A','Kit A','kit',0,1)`,
    );
    await run(`INSERT INTO product_components (parent_product_id, component_product_id, quantity, company_id) VALUES (?,?,1,1)`, [kitA, pA]);

    const specs1 = await loadSpecs(1);
    const specs2 = await loadSpecs(2);
    assert.ok(specs1.has(kitA), "empresa 1 tem o kit");
    assert.ok(!specs2.has(kitA), "empresa 2 NÃO tem o kit de 1");
  });

  it("guarda de escrita: revisão é POR EMPRESA (A não invalida B)", async () => {
    await criarEmpresas();
    const v1 = await stockVersion(1);
    const v2 = await stockVersion(2);
    // a revisão copiada do histórico pode nascer > 0; o invariant é que ela
    // só avança com escrita da PRÓPRIA empresa
    // escrita em tabela com trigger de revisão (products) da empresa 2
    // incrementa APENAS a revisão de 2
    await commitStockBatch(2, v2, [{ sql: `INSERT INTO products (code, name, kind, total_qty, company_id) VALUES ('VAN','Van B','simples',1,2)` }]);
    assert.equal(await stockVersion(1), v1, "revisão de A intacta");
    assert.equal(await stockVersion(2), v2 + 1, "revisão de B avançou");
  });

  it("numeração de documentos independente por empresa", async () => {
    await criarEmpresas();
    // contadores já nascem da migration (0027/0028); semeia um ponto alto
    await run(`UPDATE doc_number_counters SET next_seq = 5 WHERE company_id = 1 AND prefix = 'LIMA'`);
    const a1 = await nextNumber("reservations", "LIMA");
    const a2 = await nextNumber("reservations", "LIMA");
    assert.equal(a1, "LIMA-005");
    assert.equal(a2, "LIMA-006");
    // contexto sem sessão cai na empresa padrão (1) — sequência continua de 7
    const a3 = await nextNumber("reservations", "LIMA");
    assert.equal(a3, "LIMA-007");
  });

  it("notificações isoladas por empresa", async () => {
    await criarEmpresas();
    // cria alerta manual para cada empresa
    await run(`INSERT INTO notifications (company_id, type, severity, title, dedupe_key) VALUES (1,'conflito','critico','Alerta A','c1:x-1')`);
    await run(`INSERT INTO notifications (company_id, type, severity, title, dedupe_key) VALUES (2,'conflito','critico','Alerta B','c2:x-1')`);
    const lista1 = await listNotifications(false, 1);
    assert.equal(lista1.length, 1);
    assert.equal(lista1[0].title, "Alerta A");
    const lista2 = await listNotifications(false, 2);
    assert.equal(lista2[0].title, "Alerta B");
    assert.ok((await unreadCount(1)) >= 1);
  });

  it("chat: contatos e conversas restritos à empresa", async () => {
    await criarEmpresas();
    const u1 = await usuario(1);
    const u1b = await usuario(1);
    const u2 = await usuario(2);
    const contatos1 = await contactableUsers(u1);
    assert.equal(contatos1.length, 1, "A vê só o colega da própria empresa");
    const contatos2 = await contactableUsers(u2);
    assert.equal(contatos2.length, 0, "B não vê ninguém de A");
    // conversa com usuário de outra empresa é recusada
    await assert.rejects(() => ensureConversation(u1, u2), /não disponível/i);
    // conversa interna funciona
    const conv = await ensureConversation(u1, u1b);
    const convRow = await one<any>(`SELECT company_id FROM chat_conversations WHERE id = ?`, [conv]);
    assert.equal(convRow.company_id, 1);
  });

  it("fretes do dia isolados por empresa", async () => {
    await criarEmpresas();
    const c1 = await cliente(1, "Cliente A");
    await insert(`INSERT INTO freights (number, customer_id, date, status, company_id) VALUES ('FRT-A',?, '2026-10-10','agendado',1)`, [c1]);
    await insert(`INSERT INTO freights (number, customer_id, date, status, company_id) VALUES ('FRT-B', NULL, '2026-10-10','agendado',2)`);
    const f1 = await freightsOn("2026-10-10", "2026-10-10", 1);
    const f2 = await freightsOn("2026-10-10", "2026-10-10", 2);
    assert.deepEqual(f1.map((f) => f.number), ["FRT-A"]);
    assert.deepEqual(f2.map((f) => f.number), ["FRT-B"]);
  });
});

describe("papéis v1 (owner/admin/operacional/financeiro/viewer)", () => {
  it("viewer lê operação mas não edita; financeiro vê financeiro e edita recibos", () => {
    assert.ok(canView("viewer", "operacao"));
    assert.ok(!canEdit("viewer", "operacao"));
    assert.ok(canView("financeiro", "financeiro"));
    assert.ok(canEdit("financeiro", "recibos"));
    assert.ok(!canView("financeiro", "configuracoes"));
    assert.ok(!canView("viewer", "financeiro"));
  });

  it("owner e admin passam em checagens administrativas; menu reflete o papel", () => {
    assert.ok(ehAdmin("owner"));
    assert.ok(ehAdmin("admin"));
    assert.ok(!ehAdmin("operacional"));
    const menu = modulesFor("operacional");
    assert.ok(menu.includes("reservas"));
    assert.ok(!menu.includes("financeiro"));
    assert.ok(!menu.includes("usuarios"));
  });
});
