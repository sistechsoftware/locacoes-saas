/**
 * FLUXO COMPLETO DA PROMOÇÃO: cadastro -> consulta -> orçamento -> reserva.
 *
 * As duas causas-raiz corrigidas ficam provadas aqui:
 *
 *  1. SELEÇÃO — o sistema guardava SÓ A PRIMEIRA promoção por produto (a de
 *     menor id) e avaliava a vigência dela. Duas promoções do mesmo produto em
 *     períodos diferentes (setembro expirada + novembro) ou faixas de
 *     quantidade diferentes (1 a 4 e 5+), ambas permitidas pelo cadastro,
 *     deixavam a certa de fora e o preço saía normal.
 *
 *  2. SERVIDOR — o backend aceitava unit_price_cents vindo do navegador sem
 *     consultar promoção nenhuma (o cálculo vivia só no formulário). Agora
 *     createQuote/updateQuote/createReservation/updateReservation consultam as
 *     promoções vigentes NA DATA DA LOCAÇÃO e exigem o preço promocional.
 *
 * A conversão de orçamento em reserva continua preservando o que já foi
 * negociado: não reprica, não duplica e não perde o desconto.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

/* Scaffold do Next: as actions importam next/*, que exige o runtime. */
const SESSAO = "sess-promocoes-fluxo";
const carregarOriginal = (Module as any)._load;

(Module as any)._load = function (request: string) {
  if (request === "next/headers") {
    return {
      cookies: async () => ({ get: (nome: string) => (nome === "limas_session" ? { value: SESSAO } : undefined), set: () => {}, delete: () => {} }),
      headers: async () => new Map(),
    };
  }
  if (request === "next/navigation") {
    return {
      redirect: (url: string) => { throw new Error("NEXT_REDIRECT:" + url); },
      notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
      useRouter: () => ({ push() {}, replace() {}, prefetch() {} }),
      usePathname: () => "/",
      useSearchParams: () => new URLSearchParams(),
    };
  }
  if (request === "next/cache") return { revalidatePath: () => {}, revalidateTag: () => {} };
  if (request === "next/link" || request === "next/form" || request === "next/image") return { __esModule: true, default: (p: any) => p?.children ?? null, Link: (p: any) => p?.children ?? null };
  if (request === "server-only") return {};
  return carregarOriginal.apply(this, arguments as any);
};

const FUTURO = new Date(Date.now() + 864e5).toISOString();
const NORMAL = 2000; // R$ 20,00 — preço cheio do produto
const PRODUTO = 960;
const CLIENTE = 1;

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
const db = () => import("../src/lib/db.ts");
const um = async (s: string, p: any[] = []) => (await db()).one<any>(s, p);
const executar = async (s: string, p: any[] = []) => (await db()).run(s, p);

/** Banco novo + sessão de dono (empresa 1) + cliente + produto. */
async function cenario() {
  const { createTestDb, resetTestDb } = await import("./helpers/d1.ts");
  resetTestDb();
  createTestDb();
  await executar(`INSERT OR IGNORE INTO stock_revision (id, revision) VALUES (1, 0)`);
  await executar(
    `INSERT INTO users (id, name, username, password_hash, role, company_id, active)
     VALUES (11, 'Dono Promo', 'dono-promo', 'x', 'owner', 1, 1)`,
  );
  await executar(`INSERT INTO sessions (id, user_id, expires_at) VALUES (?, 11, ?)`, [SESSAO, FUTURO]);
  await executar(`INSERT INTO customers (id, name, phone, company_id) VALUES (?, 'Cliente Promo', '31999990000', 1)`, [CLIENTE]);
  await executar(
    `INSERT INTO products (id, code, name, kind, total_qty, rent_price_cents, company_id, active)
     VALUES (?, 'PROMO-P', 'Produto Promo', 'simples', 50, ?, 1, 1)`,
    [PRODUTO, NORMAL],
  );
}

type Faixa = { min: number; max: number | null; preco: number };

/**
 * Cadastra uma promoção direto na tabela (o formulário seria a mesma escrita):
 * período opcional + faixas de quantidade. `empresa` permite simular tenant.
 */
async function promocao(opts: {
  inicio?: string | null;
  fim?: string | null;
  ativa?: boolean;
  faixas: Faixa[];
  empresa?: number;
}) {
  const id = await (await db()).insert(
    `INSERT INTO promotions (product_id, name, active, starts_on, ends_on, company_id) VALUES (?,?,?,?,?,?)`,
    [PRODUTO, "Promo fluxo", opts.ativa === false ? 0 : 1, opts.inicio ?? null, opts.fim ?? null, opts.empresa ?? 1],
  );
  for (const f of opts.faixas) {
    await executar(
      `INSERT INTO promotion_tiers (promotion_id, min_qty, max_qty, unit_price_cents, company_id) VALUES (?,?,?,?,?)`,
      [id, f.min, f.max, f.preco, opts.empresa ?? 1],
    );
  }
  return id;
}

const FAIXAS_PADRAO: Faixa[] = [{ min: 5, max: null, preco: 1500 }]; // 5+ sai por R$ 15

/* ------------------------------------------------------------------ */
/* 1 — seleção entre várias promoções do mesmo produto (causa-raiz 1) */
/* ------------------------------------------------------------------ */

describe("seleção entre várias promoções do mesmo produto", () => {
  beforeEach(cenario);

  it("aplica a promoção vigente na data da locação mesmo com uma antiga cadastrada antes", async () => {
    // A de setembro nasce PRIMEIRO (menor id) e já expirou; a de novembro é a
    // que vale para a locação. Antes da correção só a primeira era enxergada.
    await promocao({ inicio: "2026-09-01", fim: "2026-09-30", faixas: [{ min: 1, max: null, preco: 1800 }] });
    await promocao({ inicio: "2026-11-01", fim: "2026-11-30", faixas: [{ min: 1, max: null, preco: 1500 }] });

    const { precoSugerido } = await import("../src/lib/promocoes-db.ts");
    assert.equal((await precoSugerido(PRODUTO, 10, "2026-11-15")).unit_price_cents, 1500, "locação em novembro usa a promoção de novembro");
    assert.equal((await precoSugerido(PRODUTO, 10, "2026-09-15")).unit_price_cents, 1800, "locação em setembro usa a de setembro");
    assert.equal((await precoSugerido(PRODUTO, 10, "2026-10-15")).unit_price_cents, NORMAL, "fora das duas vigências, preço normal");
  });

  it("soma faixas de quantidade cadastradas em promoções separadas", async () => {
    // O cadastro autoriza duas promoções do MESMO produto quando as faixas não
    // se cruzam (testado em promocoes.test.ts) — as duas têm que ser ouvidas.
    await promocao({ inicio: "2026-11-01", fim: "2026-11-30", faixas: [{ min: 1, max: 4, preco: 1900 }] });
    await promocao({ inicio: "2026-11-01", fim: "2026-11-30", faixas: [{ min: 5, max: null, preco: 1500 }] });

    const { precoSugerido } = await import("../src/lib/promocoes-db.ts");
    assert.equal((await precoSugerido(PRODUTO, 2, "2026-11-15")).unit_price_cents, 1900, "faixa 1 a 4");
    assert.equal((await precoSugerido(PRODUTO, 10, "2026-11-15")).unit_price_cents, 1500, "faixa 5+ — era esta que sumia");
  });

  it("o formulário recebe a LISTA inteira de promoções do produto", async () => {
    await promocao({ inicio: "2026-09-01", fim: "2026-09-30", faixas: [{ min: 1, max: null, preco: 1800 }] });
    await promocao({ inicio: "2026-11-01", fim: "2026-11-30", faixas: [{ min: 1, max: null, preco: 1500 }] });

    const { sellableProducts } = await import("../src/lib/stock.ts");
    const produto = (await sellableProducts(1)).find((p: any) => p.id === PRODUTO)!;
    assert.equal(produto.promocoes.length, 2, "as duas promoções ativas viajam para o editor de itens");
    assert.equal(produto.promocao?.id, produto.promocoes[0].id, "o campo legado continua apontando a primeira");
    assert.equal(produto.rent_price_cents, NORMAL, "o preço cheio do cadastro não muda");
  });

  it("a regra pura escolhe a melhor faixa entre as candidatas e respeita as bordas", async () => {
    const { precoUnitarioEntre, vigente } = await import("../src/lib/promocoes.ts");
    const expirada = { id: 1, product_id: PRODUTO, active: true, starts_on: "2026-09-01", ends_on: "2026-09-30", tiers: [{ min_qty: 1, max_qty: null, unit_price_cents: 1800 }] };
    const futura = { id: 2, product_id: PRODUTO, active: true, starts_on: "2026-11-01", ends_on: "2026-11-30", tiers: [{ min_qty: 1, max_qty: null, unit_price_cents: 1500 }] };
    const candidatas = [expirada, futura];

    assert.equal(precoUnitarioEntre(NORMAL, candidatas, 10, "2026-11-01").unit_price_cents, 1500, "primeiro dia vale");
    assert.equal(precoUnitarioEntre(NORMAL, candidatas, 10, "2026-11-30").unit_price_cents, 1500, "último dia vale");
    assert.equal(precoUnitarioEntre(NORMAL, candidatas, 10, "2026-10-31").unit_price_cents, NORMAL, "dia antes não vale");
    assert.equal(precoUnitarioEntre(NORMAL, candidatas, 10, "2026-12-01").unit_price_cents, NORMAL, "dia depois não vale");
    assert.equal(precoUnitarioEntre(NORMAL, candidatas, 10, "2026-11-15").promocional, true, "meio do mês vale");
    assert.equal(vigente(futura, ""), false, "data desconhecida não valida nada");
  });
});

/* ------------------------------------------------------------------ */
/* 2 — orçamento: o SERVIDOR aplica a promoção (causa-raiz 2)          */
/* ------------------------------------------------------------------ */

describe("orçamento — servidor aplica a promoção pela data da locação", () => {
  beforeEach(cenario);

  it("evento dentro da vigência grava o preço promocional mesmo com o navegador mandando o preço cheio", async () => {
    await promocao({ inicio: "2026-11-01", fim: "2026-11-30", faixas: FAIXAS_PADRAO });
    const { createQuote } = await carregar("src/app/(app)/orcamentos/actions.ts");
    await acao(() =>
      createQuote(null, fd({
        customer_id: String(CLIENTE),
        event_date: "2026-11-15",
        status: "rascunho",
        items: JSON.stringify([{ product_id: String(PRODUTO), qty: 10, unit_price_cents: NORMAL }]),
      })),
    );
    const q = await um(`SELECT * FROM quotes ORDER BY id DESC LIMIT 1`);
    const item = await um(`SELECT * FROM quote_items WHERE quote_id = ?`, [q.id]);
    assert.equal(item.unit_price_cents, 1500, "servidor exigiu o preço promocional");
    assert.equal(item.subtotal_cents, 15000, "10 × R$ 15,00");
    assert.equal(q.total_cents, 15000, "o total do orçamento bate com a promoção");
  });

  it("evento fora da vigência mantém o valor enviado (sem desconto indevido)", async () => {
    await promocao({ inicio: "2026-11-01", fim: "2026-11-30", faixas: FAIXAS_PADRAO });
    const { createQuote } = await carregar("src/app/(app)/orcamentos/actions.ts");
    await acao(() =>
      createQuote(null, fd({
        customer_id: String(CLIENTE),
        event_date: "2026-10-20",
        status: "rascunho",
        items: JSON.stringify([{ product_id: String(PRODUTO), qty: 10, unit_price_cents: NORMAL }]),
      })),
    );
    const item = await um(`SELECT * FROM quote_items ORDER BY id DESC LIMIT 1`);
    assert.equal(item.unit_price_cents, NORMAL, "orçamento para locação fora do período não leva promoção");
  });

  it("preço digitado a mão pelo operador não é sobrescrito pela promoção", async () => {
    await promocao({ inicio: "2026-11-01", fim: "2026-11-30", faixas: FAIXAS_PADRAO });
    const { createQuote } = await carregar("src/app/(app)/orcamentos/actions.ts");
    await acao(() =>
      createQuote(null, fd({
        customer_id: String(CLIENTE),
        event_date: "2026-11-15",
        status: "rascunho",
        items: JSON.stringify([{ product_id: String(PRODUTO), qty: 10, unit_price_cents: 1700, preco_manual: true }]),
      })),
    );
    const item = await um(`SELECT * FROM quote_items ORDER BY id DESC LIMIT 1`);
    assert.equal(item.unit_price_cents, 1700, "precedência do formulário: preço digitado manda");
  });

  it("bordas do período: dia inicial e dia final aplicam; o dia seguinte de cada um, não", async () => {
    await promocao({ inicio: "2026-11-01", fim: "2026-11-30", faixas: FAIXAS_PADRAO });
    const { createQuote } = await carregar("src/app/(app)/orcamentos/actions.ts");
    const precoEm = async (data: string) => {
      await acao(() =>
        createQuote(null, fd({
          customer_id: String(CLIENTE),
          event_date: data,
          status: "rascunho",
          items: JSON.stringify([{ product_id: String(PRODUTO), qty: 10, unit_price_cents: NORMAL }]),
        })),
      );
      const item = await um(`SELECT * FROM quote_items ORDER BY id DESC LIMIT 1`);
      return item.unit_price_cents;
    };
    assert.equal(await precoEm("2026-11-01"), 1500, "primeiro dia");
    assert.equal(await precoEm("2026-11-30"), 1500, "último dia (inclusive)");
    assert.equal(await precoEm("2026-10-31"), NORMAL, "dia anterior");
    assert.equal(await precoEm("2026-12-01"), NORMAL, "dia posterior");
  });

  it("promoção futura (criada hoje, válida em outro mês) é reconhecida em orçamento futuro", async () => {
    const { today, addDays } = await import("../src/lib/format.ts");
    const inicio = addDays(today(), 30);
    const fim = addDays(today(), 60);
    const locacao = addDays(today(), 45);
    await promocao({ inicio, fim, faixas: FAIXAS_PADRAO });

    const { createQuote } = await carregar("src/app/(app)/orcamentos/actions.ts");
    await acao(() =>
      createQuote(null, fd({
        customer_id: String(CLIENTE),
        event_date: locacao,
        status: "rascunho",
        items: JSON.stringify([{ product_id: String(PRODUTO), qty: 10, unit_price_cents: NORMAL }]),
      })),
    );
    const item = await um(`SELECT * FROM quote_items ORDER BY id DESC LIMIT 1`);
    assert.equal(item.unit_price_cents, 1500, "a vigência é a da locação, não a de hoje");
  });

  it("promoção inativa não é aplicada a documento novo", async () => {
    await promocao({ ativa: false, inicio: "2026-11-01", fim: "2026-11-30", faixas: FAIXAS_PADRAO });
    const { createQuote } = await carregar("src/app/(app)/orcamentos/actions.ts");
    await acao(() =>
      createQuote(null, fd({
        customer_id: String(CLIENTE),
        event_date: "2026-11-15",
        status: "rascunho",
        items: JSON.stringify([{ product_id: String(PRODUTO), qty: 10, unit_price_cents: NORMAL }]),
      })),
    );
    const item = await um(`SELECT * FROM quote_items ORDER BY id DESC LIMIT 1`);
    assert.equal(item.unit_price_cents, NORMAL, "inativa não vale para operações novas");
  });

  it("virada de ano: promoção de dezembro a janeiro vale nos dois anos", async () => {
    await promocao({ inicio: "2026-12-20", fim: "2027-01-10", faixas: FAIXAS_PADRAO });
    const { precoSugerido } = await import("../src/lib/promocoes-db.ts");
    assert.equal((await precoSugerido(PRODUTO, 10, "2026-12-31")).unit_price_cents, 1500, "réveillon dentro");
    assert.equal((await precoSugerido(PRODUTO, 10, "2027-01-10")).unit_price_cents, 1500, "último dia vale");
    assert.equal((await precoSugerido(PRODUTO, 10, "2027-01-11")).unit_price_cents, NORMAL, "passou, acabou");
  });
});

/* ------------------------------------------------------------------ */
/* 3 — reserva: criação direta e edição reavaliando a data             */
/* ------------------------------------------------------------------ */

describe("reserva — servidor aplica e reavalia a promoção", () => {
  beforeEach(cenario);

  it("criação direta para locação futura dentro da vigência grava o preço promocional", async () => {
    await promocao({ inicio: "2026-11-01", fim: "2026-11-30", faixas: FAIXAS_PADRAO });
    const { createReservation } = await carregar("src/app/(app)/reservas/actions.ts");
    await acao(() =>
      createReservation(null, fd({
        customer_id: String(CLIENTE),
        event_date: "2026-11-20",
        status: "pre_reserva",
        items: JSON.stringify([{ product_id: String(PRODUTO), qty: 8, unit_price_cents: NORMAL }]),
      })),
    );
    const r = await um(`SELECT * FROM reservations ORDER BY id DESC LIMIT 1`);
    const item = await um(`SELECT * FROM reservation_items WHERE reservation_id = ?`, [r.id]);
    assert.equal(item.unit_price_cents, 1500);
    assert.equal(item.subtotal_cents, 12000, "8 × R$ 15,00");
    assert.equal(r.total_cents, 12000);
  });

  it("criação fora da vigência mantém o valor enviado", async () => {
    await promocao({ inicio: "2026-11-01", fim: "2026-11-30", faixas: FAIXAS_PADRAO });
    const { createReservation } = await carregar("src/app/(app)/reservas/actions.ts");
    await acao(() =>
      createReservation(null, fd({
        customer_id: String(CLIENTE),
        event_date: "2026-12-15",
        status: "pre_reserva",
        items: JSON.stringify([{ product_id: String(PRODUTO), qty: 8, unit_price_cents: NORMAL }]),
      })),
    );
    const item = await um(`SELECT * FROM reservation_items ORDER BY id DESC LIMIT 1`);
    assert.equal(item.unit_price_cents, NORMAL);
  });

  it("editar a data da locação reavalia: entra na vigência e volta a sair", async () => {
    await promocao({ inicio: "2026-11-01", fim: "2026-11-30", faixas: FAIXAS_PADRAO });
    const { createReservation, updateReservation } = await carregar("src/app/(app)/reservas/actions.ts");
    await acao(() =>
      createReservation(null, fd({
        customer_id: String(CLIENTE),
        event_date: "2026-10-20",
        status: "pre_reserva",
        items: JSON.stringify([{ product_id: String(PRODUTO), qty: 8, unit_price_cents: NORMAL }]),
      })),
    );
    const r = await um(`SELECT * FROM reservations ORDER BY id DESC LIMIT 1`);
    const precoDe = async () => (await um(`SELECT * FROM reservation_items WHERE reservation_id = ?`, [r.id])).unit_price_cents;
    assert.equal(await precoDe(), NORMAL, "criada fora da vigência");

    const editar = (data: string) =>
      acao(() =>
        updateReservation(null, fd({
          id: String(r.id),
          customer_id: String(CLIENTE),
          event_date: data,
          status: "pre_reserva",
          items: JSON.stringify([{ product_id: String(PRODUTO), qty: 8, unit_price_cents: NORMAL }]),
        })),
      );

    await editar("2026-11-20");
    assert.equal(await precoDe(), 1500, "mudou para dentro da vigência: promoção entra");
    await editar("2026-10-20");
    assert.equal(await precoDe(), NORMAL, "voltou para fora: promoção sai");
  });

  it("promoção de OUTRO tenant nunca entra no cálculo", async () => {
    await promocao({ inicio: "2026-11-01", fim: "2026-11-30", faixas: FAIXAS_PADRAO, empresa: 2 });
    const { aplicarPromocaoNosItens } = await import("../src/lib/promocoes-db.ts");
    const itens = [{ product_id: PRODUTO, qty: 10, unit_price_cents: NORMAL }];
    const daEmpresa1 = await aplicarPromocaoNosItens(itens, "2026-11-15", 1);
    const daEmpresa2 = await aplicarPromocaoNosItens(itens, "2026-11-15", 2);
    assert.equal(daEmpresa1[0].unit_price_cents, NORMAL, "empresa 1 não enxerga a promoção da empresa 2");
    assert.equal(daEmpresa2[0].unit_price_cents, 1500, "para a dona dela, a promoção vale");
  });
});

/* ------------------------------------------------------------------ */
/* 4 — conversão de orçamento em reserva                               */
/* ------------------------------------------------------------------ */

describe("conversão de orçamento em reserva", () => {
  beforeEach(cenario);

  it("leva o preço promocional uma única vez: nem duplica, nem perde", async () => {
    await promocao({ inicio: "2026-11-01", fim: "2026-11-30", faixas: FAIXAS_PADRAO });
    const { createQuote, convertQuote } = await carregar("src/app/(app)/orcamentos/actions.ts");
    await acao(() =>
      createQuote(null, fd({
        customer_id: String(CLIENTE),
        event_date: "2026-11-20",
        event_time: "10:00",
        status: "rascunho",
        items: JSON.stringify([{ product_id: String(PRODUTO), qty: 10, unit_price_cents: NORMAL }]),
      })),
    );
    const q = await um(`SELECT * FROM quotes ORDER BY id DESC LIMIT 1`);
    const itemQuote = await um(`SELECT * FROM quote_items WHERE quote_id = ?`, [q.id]);
    assert.equal(itemQuote.unit_price_cents, 1500, "orçamento já nasce promocional");

    const url = await acao(() => convertQuote(fd({ id: String(q.id) })));
    assert.ok(url.startsWith("/reservas/"), `redirect inesperado: ${url}`);
    const reservaId = Number(url.split("/").pop());

    const itemReserva = await um(`SELECT * FROM reservation_items WHERE reservation_id = ?`, [reservaId]);
    assert.equal(itemReserva.unit_price_cents, 1500, "conversão preserva o valor negociado");
    const r = await um(`SELECT * FROM reservations WHERE id = ?`, [reservaId]);
    assert.equal(r.total_cents, 15000, "total idêntico ao do orçamento — nada duplicado nem perdido");
    const cotada = await um(`SELECT * FROM quotes WHERE id = ?`, [q.id]);
    assert.equal(cotada.status, "convertido");
  });

  it("preço manual no orçamento continua manual na conversão", async () => {
    await promocao({ inicio: "2026-11-01", fim: "2026-11-30", faixas: FAIXAS_PADRAO });
    const { createQuote, convertQuote } = await carregar("src/app/(app)/orcamentos/actions.ts");
    await acao(() =>
      createQuote(null, fd({
        customer_id: String(CLIENTE),
        event_date: "2026-11-20",
        event_time: "10:00",
        status: "rascunho",
        items: JSON.stringify([{ product_id: String(PRODUTO), qty: 10, unit_price_cents: 1700, preco_manual: true }]),
      })),
    );
    const q = await um(`SELECT * FROM quotes ORDER BY id DESC LIMIT 1`);
    const url = await acao(() => convertQuote(fd({ id: String(q.id) })));
    const reservaId = Number(url.split("/").pop());
    const itemReserva = await um(`SELECT * FROM reservation_items WHERE reservation_id = ?`, [reservaId]);
    assert.equal(itemReserva.unit_price_cents, 1700);
  });
});
