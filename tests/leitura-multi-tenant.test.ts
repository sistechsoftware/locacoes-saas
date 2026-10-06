/**
 * PENDÊNCIA #01 — Isolamento de LEITURA entre empresas.
 *
 * Estas provas executam as páginas REAIS do App Router (server components)
 * fora do runtime do Next: o cookie da sessão, o navigation e o link são
 * substituídos por um scaffold minimo, e o banco e o SQLite real com as
 * migrations reais (tests/helpers/d1.ts).
 *
 * Cenário: empresa 1 (sessão ativa) e empresa 2 marcada com "ZB" em TODOS os
 * dados. Cada tela precisa:
 *   1. renderizar (sem redirect/erro) e mostrar os dados da empresa 1;
 *   2. NUNCA devolver o marcador "ZB" da outra empresa;
 *   3. nas telas de detalhe, responder 404 para o id da outra empresa (IDOR).
 *
 * Um teste estatico complementar impede que uma statement nova sem filtro de
 * empresa volte a entrar numa página.
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/* ------------------------------------------------------------------ */
/* Scaffold do Next: as páginas importam next/*, que exige o runtime.  */
/* ------------------------------------------------------------------ */

const SESSAO = "sess-leitura-tenant";
const fakeComponent: any = (props: any) => props?.children ?? null;
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
      Link: fakeComponent,
    };
  }
  if (request === "next/link" || request === "next/form" || request === "next/image") {
    return { __esModule: true, default: fakeComponent, Link: fakeComponent };
  }
  if (request === "server-only") return {};
  return carregarOriginal.apply(this, arguments as any);
};

/* ------------------------------------------------------------------ */
/* Cenário: 2 empresas, dados distintos, marcador ZB na empresa 2      */
/* ------------------------------------------------------------------ */

const FUTURO = new Date(Date.now() + 864e5).toISOString();

async function montarCenario() {
  const { run } = await import("../src/lib/db.ts");
  const exec = async (sql: string, params: any[] = []) => run(sql, params);

  await exec(`UPDATE companies SET name = 'Empresa A' WHERE id = 1`);
  await exec(`INSERT INTO companies (id, name, active) VALUES (2, 'Empresa ZB', 1)`);
  await exec(`INSERT OR IGNORE INTO stock_revision (id, revision) VALUES (1, 0), (2, 0)`);
  await exec(
    `INSERT OR REPLACE INTO company_settings (company_id, key, value) VALUES
      (1, 'company_name', 'Empresa A'), (2, 'company_name', 'Empresa ZB')`,
  );

  await exec(
    `INSERT INTO users (id, name, username, password_hash, role, company_id, active) VALUES
      (10, 'Dono A', 'dono-a-leitura', 'x', 'owner', 1, 1),
      (11, 'Colega A', 'colega-a-leitura', 'x', 'operacional', 1, 1),
      (20, 'Dono ZB', 'dono-b-leitura', 'x', 'owner', 2, 1),
      (21, 'Colega ZB', 'colega-b-leitura', 'x', 'operacional', 2, 1)`,
  );
  await exec(`INSERT INTO sessions (id, user_id, expires_at) VALUES (?, 10, ?)`, [SESSAO, FUTURO]);

  await exec(
    `INSERT INTO customers (id, name, phone, birth_date, company_id) VALUES
      (100, 'Cliente Alice', '31999990000', '1990-05-05', 1),
      (200, 'Cliente ZB', '31999990001', '1991-06-06', 2)`,
  );
  await exec(`INSERT INTO categories (id, name, company_id) VALUES (100, 'Categoria A', 1), (200, 'Categoria ZB', 2)`);
  await exec(
    `INSERT INTO products (id, code, name, kind, total_qty, rent_price_cents, category_id, company_id) VALUES
      (100, 'PA', 'Mesa A', 'simples', 10, 8000, 100, 1),
      (200, 'PB', 'Produto ZB', 'simples', 5, 5000, 200, 2)`,
  );
  await exec(`INSERT INTO product_units (id, product_id, code, company_id) VALUES (100, 100, 'UA-1', 1), (200, 200, 'UB-1', 2)`);

  await exec(
    `INSERT INTO reservations (id, number, customer_id, status, event_date, delivery_at, pickup_at, total_cents, company_id) VALUES
      (100, 'LIMA-001', 100, 'confirmada', '2026-10-10', '2026-10-10T08:00', '2026-10-11T10:00', 50000, 1),
      (200, 'ZB-001', 200, 'confirmada', '2026-10-10', '2026-10-10T08:00', '2026-10-11T10:00', 40000, 2)`,
  );
  await exec(
    `INSERT INTO reservation_items (id, reservation_id, product_id, qty, unit_price_cents, subtotal_cents, company_id) VALUES
      (100, 100, 100, 1, 8000, 8000, 1), (200, 200, 200, 1, 5000, 5000, 2)`,
  );
  await exec(
    `INSERT INTO reservation_item_components (reservation_id, reservation_item_id, product_id, qty_per_unit, qty, company_id) VALUES
      (100, 100, 100, 1, 1, 1), (200, 200, 200, 1, 1, 2)`,
  );
  await exec(
    `INSERT INTO payments (id, reservation_id, amount_cents, method, paid_at, company_id) VALUES
      (100, 100, 50000, 'pix', '2026-10-01', 1),
      (200, 200, 40000, 'pix', '2026-10-01', 2)`,
  );
  await exec(`INSERT INTO deposits (id, reservation_id, amount_cents, status, company_id) VALUES (100, 100, 10000, 'recebida', 1), (200, 200, 10000, 'recebida', 2)`);
  await exec(
    `INSERT INTO expenses (id, date, category, description, amount_cents, company_id) VALUES
      (100, '2026-10-01', 'Manutencao', 'Despesa A', 1000, 1),
      (200, '2026-10-01', 'Finalidade ZB', 'Despesa ZB', 2000, 2)`,
  );
  await exec(`INSERT INTO expense_purposes (id, name, company_id) VALUES (100, 'Finalidade A', 1), (200, 'Finalidade ZB', 2)`);
  await exec(`INSERT INTO financial_accounts (id, name, company_id) VALUES (100, 'Conta A', 1), (200, 'Conta ZB', 2)`);
  await exec(
    `INSERT INTO financial_entries (id, direction, origin, number, description, amount_cents, due_date, reservation_id, status, company_id) VALUES
      (100, 'receber', 'outro', 'FIN-A', 'Parcela A', 50000, '2026-10-10', 100, 'aberta', 1),
      (200, 'receber', 'outro', 'ZB-FIN', 'Parcela ZB', 40000, '2026-10-10', 200, 'aberta', 2)`,
  );
  await exec(`INSERT INTO suppliers (id, name, company_id) VALUES (100, 'Fornecedor A', 1), (200, 'Fornecedor ZB', 2)`);
  await exec(
    `INSERT INTO purchases (id, number, purchase_date, supplier_id, total_cents, company_id) VALUES
      (100, 'COMP-A', '2026-10-01', 100, 3000, 1),
      (200, 'ZB-COMP', '2026-10-01', 200, 3000, 2)`,
  );
  await exec(
    `INSERT INTO purchase_items (purchase_id, product_id, qty, unit_price_cents, company_id) VALUES
      (100, 100, 1, 3000, 1), (200, 200, 1, 3000, 2)`,
  );
  await exec(`INSERT INTO vehicles (id, name, company_id) VALUES (100, 'Veiculo A', 1), (200, 'Veiculo ZB', 2)`);
  await exec(
    `INSERT INTO freights (id, number, date, destination, status, amount_cents, company_id) VALUES
      (100, 'FRT-A', '2026-10-10', 'Destino A', 'agendado', 10000, 1),
      (200, 'ZB-FRT', '2026-10-10', 'Destino ZB', 'agendado', 10000, 2)`,
  );
  // Os triggers da migration 0006 criam as activities (company_id DEFAULT 1)
  await exec(
    `INSERT INTO operations (id, kind, scheduled_at, status, reservation_id, company_id) VALUES
      (100, 'entrega', '2026-10-10T08:00', 'pendente', 100, 1),
      (200, 'entrega', '2026-10-10T08:00', 'pendente', 200, 2)`,
  );
  await exec(
    `INSERT INTO contracts (id, number, reservation_id, status, body, company_id) VALUES
      (100, 'CTR-A', 100, 'pendente', 'Corpo do Contrato A', 1),
      (200, 'ZB-CTR', 200, 'pendente', 'Corpo do Contrato ZB', 2)`,
  );
  await exec(
    `INSERT INTO contract_signatures (id, contract_id, customer_id, reservation_id, token_hash, status, signer_name, body_snapshot, signed_at, company_id) VALUES
      (100, 100, 100, 100, 'hash-a-leitura', 'assinado', 'Alice', 'Corpo do Contrato A', '2026-10-02T10:00', 1),
      (200, 200, 200, 200, 'hash-b-leitura', 'assinado', 'Signatario ZB', 'Corpo do Contrato ZB', '2026-10-02T10:00', 2)`,
  );
  await exec(
    `INSERT INTO quotes (id, number, customer_id, status, event_date, company_id) VALUES
      (100, 'ORC-A', 100, 'rascunho', '2026-11-01', 1),
      (200, 'ZB-ORC', 200, 'rascunho', '2026-11-01', 2)`,
  );
  await exec(`INSERT INTO quote_items (quote_id, product_id, qty, unit_price_cents, company_id) VALUES (100, 100, 1, 8000, 1), (200, 200, 1, 5000, 2)`);
  await exec(
    `INSERT INTO receipts (id, number, source_type, payment_id, amount_cents, paid_at, company_id) VALUES
      (100, 'REC-A', 'payment', 100, 50000, '2026-10-01', 1),
      (200, 'ZB-REC', 'payment', 200, 40000, '2026-10-01', 2)`,
  );
  await exec(`INSERT INTO notifications (company_id, type, severity, title, dedupe_key) VALUES (1, 'conflito', 'info', 'Alerta A', 'leitura:a'), (2, 'conflito', 'info', 'Alerta ZB', 'leitura:b')`);
  // audit_logs: a empresa 2 foi gravada com company_id DEFAULT 1 (coluna
  // antiga) e company_id_ref = 2 (migration 0028) — é assim em produção.
  await exec(
    `INSERT INTO audit_logs (user_id, user_name, action, entity, entity_id, summary, company_id, company_id_ref) VALUES
      (10, 'Dono A', 'criar', 'cliente', 100, 'Auditoria A', 1, 1),
      (20, 'Dono ZB', 'criar', 'cliente', 200, 'Auditoria ZB', 1, 2)`,
  );
  await exec(
    `INSERT INTO user_notifications (user_id, type, title, body, link, created_at, company_id) VALUES
      (10, 'chat', 'Notificacao A', 'texto A', '/chat', unixepoch(), 1),
      (20, 'chat', 'Notificacao ZB', 'texto ZB', '/chat', unixepoch(), 1)`,
  );
  await exec(`INSERT INTO notification_preferences (user_id, type, mode, company_id) VALUES (10, 'chat', 'auto', 1), (20, 'chat', 'auto', 1)`);
  await exec(`INSERT INTO fidelity_events (customer_id, reservation_id, kind, delta, company_id) VALUES (100, 100, 'ponto', 1, 1), (200, 200, 'ponto', 1, 2)`);
  await exec(
    `INSERT INTO fidelity_rewards (id, customer_id, kit_quantity, rule_goal, rule_validity_days, cycle, status, company_id) VALUES
      (100, 100, 1, 3, 0, 1, 'disponivel', 1),
      (200, 200, 1, 3, 0, 1, 'disponivel', 1)`,
  );
  // fidelity_messages ainda nasce com company_id DEFAULT 1 (pendência #04):
  // o escopo de leitura vem do cliente.
  await exec(
    `INSERT INTO fidelity_messages (customer_id, event, body, dedupe_key, status, company_id) VALUES
      (100, 'pos_locacao', 'Mensagem A', 'leitura:m1', 'pendente', 1),
      (200, 'pos_locacao', 'Mensagem ZB', 'leitura:m2', 'pendente', 1)`,
  );
  await exec(`INSERT INTO promotions (id, name, product_id, active, company_id) VALUES (100, 'Promo A', 100, 1, 1), (200, 'Promo ZB', 200, 1, 2)`);
  await exec(`INSERT INTO promotion_tiers (promotion_id, min_qty, unit_price_cents, company_id) VALUES (100, 1, 7000, 1), (200, 1, 4000, 2)`);
  await exec(`INSERT INTO error_logs (created_at, source, kind, message, company_id) VALUES (unixepoch(), 'cron', 'server', 'Erro A', 1), (unixepoch(), 'cron', 'server', 'Erro ZB', 2)`);
  await exec(`INSERT INTO stock_movements (product_id, qty_delta, reason, company_id) VALUES (100, 10, 'entrada A', 1), (200, 5, 'entrada ZB', 2)`);
  await exec(`INSERT INTO maintenance (product_id, started_at, status, company_id) VALUES (100, '2026-10-01', 'aberta', 1), (200, '2026-10-01', 'aberta', 2)`);
  await exec(`INSERT INTO damage_reports (reservation_id, product_id, qty, company_id) VALUES (100, 100, 1, 1), (200, 200, 1, 2)`);
  await exec(`INSERT INTO checklists (operation_id, kind, data, company_id) VALUES (100, 'entrega', '{}', 1), (200, 'entrega', '{}', 2)`);
  await exec(`INSERT INTO attachments (entity, entity_id, path, company_id) VALUES ('operacao', 100, 'a.png', 1), ('operacao', 200, 'zb.png', 2)`);
  await exec(`INSERT INTO customer_documents (customer_id, title, source, company_id) VALUES (100, 'Doc A', 'upload_manual', 1), (200, 'Doc ZB', 'upload_manual', 2)`);
  await exec(`INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, label, company_id) VALUES (10, 'https://a', 'p', 'a', 'Navegador A', 1), (20, 'https://zb', 'p', 'a', 'Navegador ZB', 1)`);
  await exec(`INSERT INTO chat_conversations (id, user_low, user_high, company_id) VALUES (100, 10, 11, 1), (200, 20, 21, 2)`);
  await exec(`INSERT INTO chat_participants (conversation_id, user_id) VALUES (100, 10), (100, 11), (200, 20), (200, 21)`);
  await exec(`INSERT INTO chat_messages (conversation_id, sender_id, body, company_id) VALUES (100, 10, 'mensagem A', 1), (200, 20, 'mensagem ZB', 2)`);
  await exec(
    `INSERT INTO subscriptions (id, company_id, plan_id, status, current_period_end) VALUES
      (100, 1, 1, 'active', '2026-12-31'), (200, 2, 1, 'active', '2026-12-31')`,
  );
  await exec(
    `INSERT INTO subscription_payments (company_id, subscription_id, amount_cents, status, due_date) VALUES
      (1, 100, 7990, 'received', '2026-10-01'), (2, 200, 7990, 'received', '2026-10-01')`,
  );
}

/* ------------------------------------------------------------------ */
/* Execução das páginas reais                                          */
/* ------------------------------------------------------------------ */

async function renderizar(arquivo: string, params: Record<string, string> = {}, sp: Record<string, string> = {}) {
  const mod = await import(pathToFileURL(path.resolve(arquivo)).href);
  assert.equal(typeof mod.default, "function", `${arquivo} não exporta componente de página`);
  return await mod.default({ params: Promise.resolve(params), searchParams: Promise.resolve(sp) });
}

function serializar(out: any): string {
  return JSON.stringify(out, (_k, v) => (v === "type" ? undefined : v));
}

type Tela = { rota: string; positivo?: string; sp?: Record<string, string> };
type Detalhe = { rota: string; idA: number; idB: number; positivo: string };

const arquivos = (rota: string) => `src/app/(app)/${rota}/page.tsx`;

const LISTAS: Tela[] = [
  { rota: "estoque", positivo: "Mesa A" },
  { rota: "clientes", positivo: "Cliente Alice" },
  { rota: "historico", positivo: "Auditoria A" },
  { rota: "relatorios", positivo: "Cliente Alice" },
  { rota: "financeiro", sp: { aba: "entradas" }, positivo: "Cliente Alice" },
  { rota: "reservas", positivo: "LIMA-001" },
  { rota: "contratos", positivo: "CTR-A" },
  { rota: "orcamentos", positivo: "ORC-A" },
  { rota: "fretes", positivo: "FRT-A" },
  { rota: "compras", positivo: "COMP-A" },
  { rota: "configuracoes", positivo: "Empresa A" },
  { rota: "fidelidade", positivo: "Mensagem A" },
  { rota: "notificacoes", positivo: "Notificacao A" },
  { rota: "notificacoes/atividades", positivo: "#100" },
  { rota: "notificacoes/preferencias" },
  { rota: "notificacoes/alertas" },
  { rota: "operacao" },
  { rota: "agenda" },
  { rota: "dashboard" },
  { rota: "busca", sp: { q: "Alice" }, positivo: "Cliente Alice" },
  { rota: "chat" },
  { rota: "aniversarios", sp: { q: "Alice" }, positivo: "Cliente Alice" },
  { rota: "disponibilidade" },
  { rota: "disponibilidade/timeline" },
  { rota: "promocoes", positivo: "Promo A" },
  { rota: "erros", positivo: "Erro A" },
  { rota: "faturamento" },
  { rota: "assinatura-bloqueada" },
  { rota: "clientes/novo" },
  { rota: "estoque/novo", positivo: "Mesa A" },
  { rota: "fretes/novo", positivo: "Cliente Alice" },
  { rota: "fretes/calculadora" },
  { rota: "compras/nova", positivo: "Mesa A" },
  { rota: "operacao/nova", positivo: "LIMA-001" },
  { rota: "orcamentos/novo", positivo: "Cliente Alice" },
  { rota: "reservas/nova", positivo: "Cliente Alice" },
];

const DETALHES: Detalhe[] = [
  { rota: "clientes/[id]", idA: 100, idB: 200, positivo: "Cliente Alice" },
  { rota: "estoque/[id]", idA: 100, idB: 200, positivo: "Mesa A" },
  { rota: "reservas/[id]", idA: 100, idB: 200, positivo: "LIMA-001" },
  { rota: "fretes/[id]", idA: 100, idB: 200, positivo: "FRT-A" },
  { rota: "compras/[id]", idA: 100, idB: 200, positivo: "COMP-A" },
  { rota: "contratos/[id]", idA: 100, idB: 200, positivo: "CTR-A" },
  { rota: "operacao/[id]", idA: 100, idB: 200, positivo: "Cliente Alice" },
  { rota: "orcamentos/[id]", idA: 100, idB: 200, positivo: "ORC-A" },
  { rota: "recibos/[id]", idA: 100, idB: 200, positivo: "REC-A" },
  { rota: "promocoes/[id]", idA: 100, idB: 200, positivo: "Promo A" },
  { rota: "contratos/assinado/[id]", idA: 100, idB: 200, positivo: "Contrato A" },
  { rota: "clientes/[id]/editar", idA: 100, idB: 200, positivo: "Cliente Alice" },
  { rota: "estoque/[id]/editar", idA: 100, idB: 200, positivo: "Mesa A" },
  { rota: "reservas/[id]/editar", idA: 100, idB: 200, positivo: "LIMA-001" },
  { rota: "fretes/[id]/editar", idA: 100, idB: 200, positivo: "FRT-A" },
  { rota: "compras/[id]/editar", idA: 100, idB: 200, positivo: "COMP-A" },
  { rota: "orcamentos/[id]/editar", idA: 100, idB: 200, positivo: "ORC-A" },
  { rota: "orcamentos/[id]/imprimir", idA: 100, idB: 200, positivo: "ORC-A" },
];

before(async () => {
  // O JSX das páginas sai como React.createElement (classic runtime) sob tsx.
  (globalThis as any).React = await import("react");
  const { createTestDb, resetTestDb } = await import("./helpers/d1.ts");
  const db = await import("../src/lib/db.ts");
  resetTestDb();
  db.resetCompanyCache();
  createTestDb();
  await montarCenario();
});

describe("PENDÊNCIA #01 — telas de listagem não vazam dados de outra empresa", () => {
  for (const tela of LISTAS) {
    it(`/${tela.rota} renderiza só a empresa da sessão`, async () => {
      const out = await renderizar(arquivos(tela.rota), {}, tela.sp ?? {});
      const json = serializar(out);
      assert.ok(!json.includes("ZB"), `/${tela.rota} devolveu dado da empresa 2 (marcador ZB)`);
      if (tela.positivo) {
        assert.ok(json.includes(tela.positivo), `/${tela.rota} não mostrou o dado esperado da empresa 1 (${tela.positivo})`);
      }
    });
  }
});

describe("PENDÊNCIA #01 — telas de detalhe fecham IDOR por id", () => {
  for (const tela of DETALHES) {
    it(`/${tela.rota} mostra o registro da própria empresa`, async () => {
      const out = await renderizar(arquivos(tela.rota), { id: String(tela.idA) });
      const json = serializar(out);
      assert.ok(!json.includes("ZB"), `/${tela.rota} devolveu dado da empresa 2 (marcador ZB)`);
      assert.ok(json.includes(tela.positivo), `/${tela.rota} não mostrou o registro da empresa 1 (${tela.positivo})`);
    });

    it(`/${tela.rota} responde 404 para o id da outra empresa`, async () => {
      await assert.rejects(
        () => renderizar(arquivos(tela.rota), { id: String(tela.idB) }),
        (e: any) => String(e?.message ?? e).includes("NEXT_NOT_FOUND"),
        `/${tela.rota} não devolveu 404 para o registro da empresa 2`,
      );
    });
  }
});

describe("PENDÊNCIA #01 — guarda estática contra statements novas sem empresa", () => {
  it("toda statement SQL em page.tsx declara company_id (ou nasce de cláusula montada)", () => {
    const problemas: string[] = [];
    const raiz = path.resolve("src/app/(app)");
    const varrer = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) varrer(p);
        else if (e.name === "page.tsx") {
          const fonte = fs.readFileSync(p, "utf8");
          const re = /`([^`]*)`/gs;
          let m: RegExpExecArray | null;
          while ((m = re.exec(fonte))) {
            const sql = m[1];
            if (!/\b(SELECT|UPDATE|DELETE)\b/i.test(sql)) continue;
            if (!/\bFROM\s+\w+/i.test(sql)) continue;
            const declarado = /company_id/i.test(sql) || /company_id_ref/i.test(sql);
            // statement montada: a condicao de empresa vive na clausula interpolada
            const montada = /\$\{/.test(sql);
            if (!declarado && !montada) {
              problemas.push(`${p}: ${sql.replace(/\s+/g, " ").trim().slice(0, 120)}`);
            }
          }
        }
      }
    };
    varrer(raiz);
    assert.deepEqual(problemas, [], `statements sem filtro de empresa:\n${problemas.join("\n")}`);
  });
});
