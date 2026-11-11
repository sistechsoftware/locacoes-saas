/**
 * DUPLICAÇÃO DE PRODUTOS — cria um cadastro novo a partir de outro da MESMA
 * empresa, sem vínculo operacional e sem tocar no original.
 *
 * Importa a action REAL do App Router (mesmo scaffold do codigo-produto.test.ts)
 * sobre o SQLite com as migrations reais. A sessão é mutável no scaffold para
 * exercitar papéis e empresas diferentes.
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SESSAO_DONO = "sess-dup-dono";
const SESSAO_VIEWER = "sess-dup-viewer";
const SESSAO_DONO_ZB = "sess-dup-dono-zb";
let sessaoAtual = SESSAO_DONO;

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
  if (request === "next/cache") return { revalidatePath: () => {}, revalidateTag: () => {} };
  if (request === "next/link" || request === "next/form" || request === "next/image")
    return { __esModule: true, default: (p: any) => p?.children ?? null, Link: (p: any) => p?.children ?? null };
  if (request === "server-only") return {};
  return carregarOriginal.apply(this, arguments as any);
};

const FOTO = "/api/arquivo/0123456789abcdef0123456789abcdef";

function fd(pares: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(pares)) f.set(k, v);
  return f;
}

/** Chama uma action; devolve a URL do NEXT_REDIRECT ou "" em actions void. */
async function acao(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return "";
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (msg.startsWith("NEXT_REDIRECT:")) return msg.slice("NEXT_REDIRECT:".length);
    throw e;
  }
}

const carregar = (rel: string) => import(pathToFileURL(path.resolve(rel)).href);
const um = async (s: string, p: any[] = []) => (await import("../src/lib/db.ts")).one<any>(s, p);
const todos = async (s: string, p: any[] = []) => (await import("../src/lib/db.ts")).all<any>(s, p);
const conta = async (s: string, p: any[] = []) => (await import("../src/lib/db.ts")).scalar<number>(s, p);

let originalId = 0;
let kitId = 0;
let componente1 = 0;
let componente2 = 0;

before(async () => {
  const { createTestDb, resetTestDb } = await import("./helpers/d1.ts");
  resetTestDb();
  createTestDb();
  const { insert, run } = await import("../src/lib/db.ts");

  await run(`UPDATE companies SET name = 'Empresa A' WHERE id = 1`);
  await run(`INSERT INTO companies (id, name, active) VALUES (2, 'Empresa ZB', 1)`);
  await run(`INSERT OR IGNORE INTO stock_revision (id, revision) VALUES (1, 0), (2, 0)`);
  await run(
    `INSERT INTO users (id, name, username, password_hash, role, company_id, active) VALUES
       (10, 'Dono A', 'dono-dup', 'x', 'owner', 1, 1),
       (11, 'Consulta A', 'viewer-dup', 'x', 'viewer', 1, 1),
       (12, 'Dono ZB', 'dono-dup-zb', 'x', 'owner', 2, 1)`,
  );
  const futuro = new Date(Date.now() + 864e5).toISOString();
  await run(
    `INSERT INTO sessions (id, user_id, expires_at) VALUES (?,10,?),(?,11,?),(?,12,?)`,
    [SESSAO_DONO, futuro, SESSAO_VIEWER, futuro, SESSAO_DONO_ZB, futuro],
  );
  await run(`INSERT INTO categories (id, name, company_id) VALUES (7, 'Tecido', 1)`);

  // Produto modelo: categoria, preços, descrição, foto, cobrança por diária, estoque.
  originalId = await insert(
    `INSERT INTO products (code, name, category_id, kind, total_qty, min_qty, rent_price_cents, replace_cents,
                           description, photo, pricing_mode, company_id)
     VALUES ('FORRO-BRANCO', 'Forro Branco', 7, 'simples', 50, 5, 1500, 3000,
             'Forro de mesa branco', ?, 'diaria', 1)`,
    [FOTO],
  );
  // Promoção individual do original (não pode acompanhar o duplicado).
  const promoId = await insert(
    `INSERT INTO promotions (product_id, name, starts_on, ends_on, active, company_id)
     VALUES (?, 'Promo forro', '2026-01-01', '2026-12-31', 1, 1)`,
    [originalId],
  );
  await insert(
    `INSERT INTO promotion_tiers (promotion_id, min_qty, max_qty, unit_price_cents, company_id)
     VALUES (?, 10, NULL, 1200, 1)`,
    [promoId],
  );
  // Unidades individuais e reserva do original: registros operacionais dele.
  await insert(`INSERT INTO product_units (product_id, code, company_id) VALUES (?, 'FORRO-BRANCO-001', 1)`, [
    originalId,
  ]);
  const clienteId = await insert(`INSERT INTO customers (name, company_id) VALUES ('Cliente Dup', 1)`);
  const reservaId = await insert(
    `INSERT INTO reservations (number, customer_id, event_date, company_id) VALUES ('LIMA-DUP-001', ?, '2026-10-10', 1)`,
    [clienteId],
  );
  await insert(
    `INSERT INTO reservation_items (reservation_id, product_id, qty, unit_price_cents, company_id)
     VALUES (?, ?, 10, 1500, 1)`,
    [reservaId, originalId],
  );

  // Kit modelo e seus dois componentes (produtos simples).
  componente1 = await insert(
    `INSERT INTO products (code, name, kind, total_qty, company_id) VALUES ('DUP-MESA', 'Mesa dup', 'simples', 20, 1)`,
  );
  componente2 = await insert(
    `INSERT INTO products (code, name, kind, total_qty, company_id) VALUES ('DUP-CAD', 'Cadeira dup', 'simples', 40, 1)`,
  );
  kitId = await insert(
    `INSERT INTO products (code, name, kind, total_qty, rent_price_cents, company_id)
     VALUES ('DUP-KIT', 'Kit dup', 'kit', 0, 20000, 1)`,
  );
  await insert(
    `INSERT INTO product_components (parent_product_id, component_product_id, quantity, company_id) VALUES (?,?,2,1)`,
    [kitId, componente1],
  );
  await insert(
    `INSERT INTO product_components (parent_product_id, component_product_id, quantity, company_id) VALUES (?,?,4,1)`,
    [kitId, componente2],
  );
});

/** Formulário de duplicação já preenchido como a página pré-preenche. */
const fdDuplicacao = (extra: Record<string, string> = {}) =>
  fd({
    source_id: String(originalId),
    name: "Forro Azul",
    kind: "simples",
    total_qty: "0",
    min_qty: "5",
    rent_price: "15,00",
    replace_price: "30,00",
    category_id: "7",
    description: "Forro de mesa branco",
    photo: FOTO,
    pricing_mode: "diaria",
    ...extra,
  });

describe("duplicar produto — cadastro novo e independente", () => {
  it("copies the model fields and creates a NEW product with its own id/code", async () => {
    const { duplicateProduct } = await carregar("src/app/(app)/estoque/actions.ts");
    const url = await acao(() => duplicateProduct(null, fdDuplicacao()));
    const novo = await um(`SELECT * FROM products WHERE name = 'Forro Azul'`);

    assert.ok(novo, "o duplicado existe");
    assert.equal(url, `/estoque/${novo.id}`, "salvar leva ao produto criado");
    assert.notEqual(novo.id, originalId, "id próprio");
    assert.match(novo.code, /^PROD-\d{3}$/, "código novo gerado pelo sistema");
    assert.equal(novo.company_id, 1);
    assert.equal(novo.category_id, 7, "categoria copiada");
    assert.equal(novo.rent_price_cents, 1500, "valor de locação copiado");
    assert.equal(novo.replace_cents, 3000, "valor de reposição copiado");
    assert.equal(novo.min_qty, 5, "estoque mínimo copiado");
    assert.equal(novo.description, "Forro de mesa branco");
    assert.equal(novo.pricing_mode, "diaria", "configuração comercial copiada");
    assert.equal(novo.kind, "simples");
    assert.equal(novo.total_qty, 0, "estoque não é herdado");
    assert.equal(novo.maintenance_qty, 0);
    assert.equal(novo.active, 1);

    const original = await um(`SELECT * FROM products WHERE id = ?`, [originalId]);
    assert.equal(original.name, "Forro Branco", "o modelo não muda de nome");
    assert.equal(original.code, "FORRO-BRANCO", "o modelo não muda de código");
    assert.equal(original.total_qty, 50, "o estoque do modelo fica intacto");
  });

  it("does not copy operational records (units, reservations, stock movements)", async () => {
    const novo = await um(`SELECT * FROM products WHERE name = 'Forro Azul'`);
    assert.equal(await conta(`SELECT COUNT(*) FROM product_units WHERE product_id = ?`, [novo.id]), 0);
    assert.equal(await conta(`SELECT COUNT(*) FROM reservation_items WHERE product_id = ?`, [novo.id]), 0);
    assert.equal(await conta(`SELECT COUNT(*) FROM stock_movements WHERE product_id = ?`, [novo.id]), 0);
    assert.equal(await conta(`SELECT COUNT(*) FROM maintenance WHERE product_id = ?`, [novo.id]), 0);
    // o original mantém os dele
    assert.equal(await conta(`SELECT COUNT(*) FROM product_units WHERE product_id = ?`, [originalId]), 1);
    assert.equal(await conta(`SELECT COUNT(*) FROM reservation_items WHERE product_id = ?`, [originalId]), 1);
  });

  it("does not copy promotions: a promoção do modelo não vale para o duplicado", async () => {
    const novo = await um(`SELECT * FROM products WHERE name = 'Forro Azul'`);
    assert.equal(await conta(`SELECT COUNT(*) FROM promotions WHERE product_id = ?`, [novo.id]), 0);
    assert.equal(await conta(`SELECT COUNT(*) FROM promotions WHERE product_id = ?`, [originalId]), 1);
  });

  it("reuses the photo URL without touching the model when the copy changes its photo", async () => {
    const { updateProduct } = await carregar("src/app/(app)/estoque/actions.ts");
    const novo = await um(`SELECT * FROM products WHERE name = 'Forro Azul'`);
    assert.equal(novo.photo, FOTO, "a imagem é reaproveitada pela URL (mesma linha em files)");

    await acao(() =>
      updateProduct(
        null,
        fd({
          id: String(novo.id),
          name: "Forro Azul",
          kind: "simples",
          total_qty: "0",
          category_id: "7",
          photo: "/api/arquivo/ffffffffffffffffffffffffffffffff",
          pricing_mode: "diaria",
        }),
      ),
    );

    const depois = await um(`SELECT * FROM products WHERE id = ?`, [novo.id]);
    const original = await um(`SELECT * FROM products WHERE id = ?`, [originalId]);
    assert.equal(depois.photo, "/api/arquivo/ffffffffffffffffffffffffffffffff");
    assert.equal(original.photo, FOTO, "a foto do original não muda");
    assert.equal(await conta(`SELECT COUNT(*) FROM files`), 0, "nenhum arquivo novo é criado");
  });

  it("keeps stock independent: mudar a quantidade do duplicado não altera o modelo", async () => {
    const { updateProduct } = await carregar("src/app/(app)/estoque/actions.ts");
    const novo = await um(`SELECT * FROM products WHERE name = 'Forro Azul'`);
    await acao(() =>
      updateProduct(
        null,
        fd({ id: String(novo.id), name: "Forro Azul", kind: "simples", total_qty: "12", category_id: "7" }),
      ),
    );
    const duplicado = await um(`SELECT total_qty FROM products WHERE id = ?`, [novo.id]);
    const original = await um(`SELECT total_qty FROM products WHERE id = ?`, [originalId]);
    assert.equal(duplicado.total_qty, 12);
    assert.equal(original.total_qty, 50);
  });

  it("editing the copy (name/price) never rewrites the model", async () => {
    const { updateProduct } = await carregar("src/app/(app)/estoque/actions.ts");
    const novo = await um(`SELECT * FROM products WHERE name = 'Forro Azul'`);
    await acao(() =>
      updateProduct(
        null,
        fd({
          id: String(novo.id),
          name: "Forro Azul Royal",
          kind: "simples",
          total_qty: "12",
          category_id: "7",
          rent_price: "99,90",
          pricing_mode: "fixo",
        }),
      ),
    );
    const depois = await um(`SELECT * FROM products WHERE id = ?`, [novo.id]);
    const original = await um(`SELECT * FROM products WHERE id = ?`, [originalId]);
    assert.equal(depois.name, "Forro Azul Royal");
    assert.equal(depois.rent_price_cents, 9990);
    assert.equal(depois.pricing_mode, "fixo");
    assert.equal(original.name, "Forro Branco");
    assert.equal(original.rent_price_cents, 1500);
    assert.equal(original.pricing_mode, "diaria");
  });

  it("a copy can be deleted without deleting the model", async () => {
    const { deleteProduct } = await carregar("src/app/(app)/estoque/actions.ts");
    const novo = await um(`SELECT * FROM products WHERE name = 'Forro Azul Royal'`);
    const url = await acao(() => deleteProduct(fd({ id: String(novo.id) })));
    assert.equal(url, "/estoque");
    assert.equal(await um(`SELECT * FROM products WHERE id = ?`, [novo.id]), undefined);
    const original = await um(`SELECT * FROM products WHERE id = ?`, [originalId]);
    assert.ok(original, "o produto de origem continua existindo");
  });
});

describe("duplicar produto — permissão e isolamento entre empresas", () => {
  it("recusa quem só consulta (viewer) sem gravar nada", async () => {
    const { duplicateProduct } = await carregar("src/app/(app)/estoque/actions.ts");
    sessaoAtual = SESSAO_VIEWER;
    try {
      await assert.rejects(
        () => duplicateProduct(null, fdDuplicacao({ name: "Forro Proibido" })),
        (e: any) => e?.name === "PermissionError",
      );
    } finally {
      sessaoAtual = SESSAO_DONO;
    }
    assert.equal(await um(`SELECT * FROM products WHERE name = 'Forro Proibido'`), undefined);
  });

  it("não aceita produto de OUTRA empresa como modelo nem cria no tenant errado", async () => {
    const { duplicateProduct } = await carregar("src/app/(app)/estoque/actions.ts");
    sessaoAtual = SESSAO_DONO_ZB;
    try {
      const erro = await duplicateProduct(null, fdDuplicacao({ name: "Forro Vazado" }));
      assert.equal(erro, "Produto de origem não encontrado.");
    } finally {
      sessaoAtual = SESSAO_DONO;
    }
    assert.equal(await um(`SELECT * FROM products WHERE name = 'Forro Vazado'`), undefined);
    assert.equal(await conta(`SELECT COUNT(*) FROM products WHERE company_id = 2`), 0);
  });
});

describe("duplicar produto — kits e cadastro convencional", () => {
  it("duplicates a kit with its own composition rows", async () => {
    const { duplicateProduct } = await carregar("src/app/(app)/estoque/actions.ts");
    await acao(() =>
      duplicateProduct(
        null,
        fd({
          source_id: String(kitId),
          name: "Kit dup azul",
          kind: "kit",
          rent_price: "200,00",
          pricing_mode: "fixo",
          components: JSON.stringify([
            { product_id: componente1, quantity: 2 },
            { product_id: componente2, quantity: 4 },
          ]),
        }),
      ),
    );

    const novo = await um(`SELECT * FROM products WHERE name = 'Kit dup azul'`);
    assert.ok(novo);
    assert.notEqual(novo.id, kitId);
    assert.equal(novo.kind, "kit");
    assert.equal(novo.code !== "DUP-KIT", true, "código próprio");
    assert.equal(novo.total_qty, 0, "kit continua sem estoque próprio");

    const comps = await todos(
      `SELECT component_product_id, quantity FROM product_components WHERE parent_product_id = ? ORDER BY component_product_id`,
      [novo.id],
    );
    assert.equal(comps.length, 2);
    assert.deepEqual(comps.map((c: any) => [c.component_product_id, c.quantity]), [
      [componente1, 2],
      [componente2, 4],
    ]);

    const doOriginal = await todos(
      `SELECT component_product_id, quantity FROM product_components WHERE parent_product_id = ?`,
      [kitId],
    );
    assert.equal(doOriginal.length, 2, "a composição do kit original não muda");
  });

  it("conventional registration still works after the change", async () => {
    const { createProduct } = await carregar("src/app/(app)/estoque/actions.ts");
    await acao(() => createProduct(null, fd({ name: "Forro Verde", kind: "simples", total_qty: "3" })));
    const p = await um(`SELECT * FROM products WHERE name = 'Forro Verde'`);
    assert.ok(p);
    assert.equal(p.company_id, 1);
    assert.match(p.code, /^PROD-\d{3}$/);
    assert.equal(p.total_qty, 3);
  });
});
