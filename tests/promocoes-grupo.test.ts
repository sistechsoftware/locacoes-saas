/**
 * PROMOÇÕES EM MASSA POR SELEÇÃO DE PRODUTOS.
 *
 * A implementação NÃO cria um segundo motor de preço: cada produto selecionado
 * tem a própria linha em `promotions` (com as próprias faixas), ligada às demais
 * pelo `group_id`. As regras da funcionalidade ficam provadas aqui:
 *
 *  A. promoção individual continua idêntica (inclusive na edição);
 *  B. grupo de 5 produtos aplica a mesma regra aos 5;
 *  C. seleção parcial: os não selecionados não mudam;
 *  D. faixas são avaliadas pela quantidade DE CADA produto (nunca somadas);
 *  E. período vale por promoção, na data da locação (bordas incluídas);
 *  F. conflito com promoção individual do mesmo produto é recusado, com o nome
 *     do produto na mensagem, sem gravar nada;
 *  G. orçamento e reserva novos aplicam grupo + individual corretamente;
 *  H. documento já salvo não muda de valor quando o grupo nasce depois;
 *  I. editar o grupo (adicionar/remover produto, mudar faixa) só toca no grupo.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

/* Scaffold do Next: as actions importam next/*, que exige o runtime. */
const SESSAO = "sess-promocoes-grupo";
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
  if (request === "next/cache") return { revalidatePath: () => {}, revalidateTag: () => {} };
  if (request === "next/link" || request === "next/form" || request === "next/image") {
    return { __esModule: true, default: (p: any) => p?.children ?? null, Link: (p: any) => p?.children ?? null };
  }
  if (request === "server-only") return {};
  return carregarOriginal.apply(this, arguments as any);
};

const FUTURO = new Date(Date.now() + 864e5).toISOString();
const NORMAL = 500; // R$ 5,00 — preço de catálogo do forro
const KIT = 960; // produto sem promoção nenhuma
const FORROS = [961, 962, 963, 964, 965];
const CORES = ["branco", "azul", "vermelho", "amarelo", "verde"];
const CLIENTE = 1;
const DENTRO = "2026-12-15";

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
const todos = async (s: string, p: any[] = []) => (await db()).all<any>(s, p);
const executar = async (s: string, p: any[] = []) => (await db()).run(s, p);
const preco = async (produto: number, qty: number, data = DENTRO) =>
  (await import("../src/lib/promocoes-db.ts")).precoSugerido(produto, qty, data);

type Faixa = { min: number; max: number | null; preco: number };
const tiers = (faixas: Faixa[]) =>
  JSON.stringify(
    faixas.map((f) => ({ min_qty: f.min, max_qty: f.max, unit_price_cents: f.preco })),
  );

/** Banco novo + sessão de dono (empresa 1) + cliente + kit + cinco forros. */
async function cenario() {
  const { createTestDb, resetTestDb } = await import("./helpers/d1.ts");
  resetTestDb();
  createTestDb();
  await executar(`INSERT OR IGNORE INTO stock_revision (id, revision) VALUES (1, 0)`);
  await executar(
    `INSERT INTO users (id, name, username, password_hash, role, company_id, active)
     VALUES (11, 'Dono Grupo', 'dono-grupo', 'x', 'owner', 1, 1)`,
  );
  await executar(`INSERT INTO sessions (id, user_id, expires_at) VALUES (?, 11, ?)`, [SESSAO, FUTURO]);
  await executar(
    `INSERT INTO customers (id, name, phone, company_id) VALUES (?, 'Cliente Grupo', '31999990000', 1)`,
    [CLIENTE],
  );
  await executar(
    `INSERT INTO products (id, code, name, kind, total_qty, rent_price_cents, company_id, active)
     VALUES (?, 'KIT', 'Kit Mesa', 'kit', 0, 2000, 1, 1)`,
    [KIT],
  );
  for (let i = 0; i < FORROS.length; i++) {
    await executar(
      `INSERT INTO products (id, code, name, kind, total_qty, rent_price_cents, company_id, active)
       VALUES (?, ?, ?, 'simples', 50, ?, 1, 1)`,
      [FORROS[i], `FR-${CORES[i].toUpperCase()}`, `Forro ${CORES[i]}`, NORMAL],
    );
  }
}

async function criarGrupo(opts: {
  produtos: number[];
  faixas: Faixa[];
  inicio?: string;
  fim?: string;
  nome?: string;
  ativa?: boolean;
}): Promise<string> {
  const m = await carregar("src/app/(app)/promocoes/actions.ts");
  return await acao(() =>
    m.createPromotion(
      null,
      fd({
        name: opts.nome ?? "Forros em promoção",
        tiers: tiers(opts.faixas),
        active: opts.ativa === false ? "0" : "1",
        starts_on: opts.inicio ?? "",
        ends_on: opts.fim ?? "",
        product_ids: JSON.stringify(opts.produtos),
      }),
    ),
  );
}

async function criarIndividual(
  produto: number,
  faixas: Faixa[],
  opts: { inicio?: string; fim?: string; nome?: string } = {},
): Promise<string> {
  const m = await carregar("src/app/(app)/promocoes/actions.ts");
  return await acao(() =>
    m.createPromotion(
      null,
      fd({
        name: opts.nome ?? "Promo individual",
        product_id: String(produto),
        tiers: tiers(faixas),
        active: "1",
        starts_on: opts.inicio ?? "",
        ends_on: opts.fim ?? "",
      }),
    ),
  );
}

async function editarGrupo(opts: {
  groupId: number;
  produtos: number[];
  faixas: Faixa[];
  inicio?: string;
  fim?: string;
  nome?: string;
  ativa?: boolean;
}): Promise<string> {
  const m = await carregar("src/app/(app)/promocoes/actions.ts");
  return await acao(() =>
    m.updateGroupPromotion(
      null,
      fd({
        group_id: String(opts.groupId),
        name: opts.nome ?? "Forros em promoção",
        tiers: tiers(opts.faixas),
        active: opts.ativa === false ? "0" : "1",
        starts_on: opts.inicio ?? "",
        ends_on: opts.fim ?? "",
        product_ids: JSON.stringify(opts.produtos),
      }),
    ),
  );
}

const idDaUrl = (url: string) => Number(url.split("/").filter(Boolean).pop());

const membrosDoGrupo = (groupId: number) =>
  todos(`SELECT * FROM promotions WHERE group_id = ? ORDER BY product_id`, [groupId]);

/* ------------------------------------------------------------------ */
/* A — promoção individual continua exatamente como antes              */
/* ------------------------------------------------------------------ */

describe("A — promoção individual", () => {
  beforeEach(cenario);

  it("cria sem grupo, com as faixas, e o preço promocional vale", async () => {
    const url = await criarIndividual(FORROS[0], [
      { min: 1, max: 4, preco: 450 },
      { min: 5, max: null, preco: 300 },
    ]);
    assert.ok(url.startsWith("/promocoes/"), `redirect inesperado: ${url}`);
    const promo = await um(`SELECT * FROM promotions WHERE id = ?`, [idDaUrl(url)]);
    assert.equal(promo.group_id, null, "promoção individual não tem grupo");
    assert.equal(promo.product_id, FORROS[0]);
    assert.equal((await todos(`SELECT * FROM promotion_tiers WHERE promotion_id = ?`, [promo.id])).length, 2);
    assert.equal((await preco(FORROS[0], 3)).unit_price_cents, 450);
    assert.equal((await preco(FORROS[0], 5)).unit_price_cents, 300);
    assert.equal((await preco(FORROS[1], 5)).unit_price_cents, NORMAL, "outro produto não é afetado");
  });

  it("edição individual troca faixas e continua individual", async () => {
    const url = await criarIndividual(FORROS[0], [{ min: 5, max: null, preco: 300 }]);
    const id = idDaUrl(url);
    const m = await carregar("src/app/(app)/promocoes/actions.ts");
    await acao(() =>
      m.updatePromotion(
        null,
        fd({
          id: String(id),
          product_id: String(FORROS[0]),
          name: "Promo revisada",
          tiers: tiers([{ min: 5, max: null, preco: 280 }]),
          active: "1",
          starts_on: "",
          ends_on: "",
        }),
      ),
    );
    assert.equal((await preco(FORROS[0], 5)).unit_price_cents, 280);
    assert.equal((await um(`SELECT * FROM promotions WHERE id = ?`, [id])).group_id, null);
  });
});

/* ------------------------------------------------------------------ */
/* B e C — grupo completo e seleção parcial                           */
/* ------------------------------------------------------------------ */

describe("B — promoção em grupo", () => {
  beforeEach(cenario);

  it("cinco produtos recebem a mesma regra promocional", async () => {
    const url = await criarGrupo({ produtos: FORROS, faixas: [{ min: 5, max: null, preco: 300 }] });
    assert.ok(url.startsWith("/promocoes/grupo/"), `redirect inesperado: ${url}`);
    const groupId = idDaUrl(url);

    const grupo = await um(`SELECT * FROM promotion_groups WHERE id = ?`, [groupId]);
    assert.equal(grupo.name, "Forros em promoção");

    const membros = await membrosDoGrupo(groupId);
    assert.equal(membros.length, 5);
    assert.deepEqual(membros.map((m: any) => m.product_id), FORROS);
    assert.deepEqual(
      [...new Set(membros.map((m: any) => `${m.active}|${m.starts_on ?? "-"}|${m.ends_on ?? "-"}`))],
      ["1|-|-"],
      "mesma configuração compartilhada em todos",
    );

    for (const produto of FORROS) {
      assert.equal((await preco(produto, 5)).unit_price_cents, 300, `forro ${produto}`);
      assert.equal((await preco(produto, 4)).unit_price_cents, NORMAL, `forro ${produto} abaixo da faixa`);
    }
    assert.equal((await preco(KIT, 5)).unit_price_cents, 2000, "produto fora do grupo não muda");
  });

  it("promoção em grupo aparece uma vez na listagem, com o total de produtos", async () => {
    const groupId = idDaUrl(await criarGrupo({ produtos: FORROS, faixas: [{ min: 5, max: null, preco: 300 }] }));
    const { listarPromocoes } = await import("../src/lib/promocoes-db.ts");
    const lista = await listarPromocoes();
    assert.equal(lista.length, 5, "uma linha por produto no banco");
    assert.ok(lista.every((p: any) => p.group_id === groupId));
    assert.equal(new Set(lista.map((p: any) => p.group_name)).size, 1);
    assert.ok(lista.every((p: any) => Number(p.group_size) === 5));
  });
});

describe("C — seleção parcial", () => {
  beforeEach(cenario);

  it("só os produtos selecionados entram no grupo", async () => {
    const selecionados = FORROS.slice(0, 3);
    const groupId = idDaUrl(await criarGrupo({ produtos: selecionados, faixas: [{ min: 5, max: null, preco: 300 }] }));

    const membros = await membrosDoGrupo(groupId);
    assert.deepEqual(membros.map((m: any) => m.product_id), selecionados);

    for (const produto of selecionados) assert.equal((await preco(produto, 5)).unit_price_cents, 300);
    for (const produto of FORROS.slice(3)) {
      assert.equal((await preco(produto, 5)).unit_price_cents, NORMAL, `forro ${produto} permanece sem alteração`);
      assert.equal(
        (await todos(`SELECT * FROM promotions WHERE product_id = ?`, [produto])).length,
        0,
        "nenhuma promoção criada para quem não foi selecionado",
      );
    }
  });
});

/* ------------------------------------------------------------------ */
/* D — faixas de quantidade, por produto                              */
/* ------------------------------------------------------------------ */

describe("D — faixas de quantidade", () => {
  beforeEach(cenario);

  it("cada produto usa a própria quantidade; quantidades não somam", async () => {
    await criarGrupo({
      produtos: [FORROS[0], FORROS[1]],
      faixas: [
        { min: 1, max: 4, preco: 400 },
        { min: 5, max: 9, preco: 300 },
        { min: 10, max: null, preco: 250 },
      ],
    });

    assert.equal((await preco(FORROS[0], 3)).unit_price_cents, 400);
    // 3 + 3 = 6 unidades no total, mas nenhum produto chega à faixa de 5
    assert.equal((await preco(FORROS[1], 3)).unit_price_cents, 400, "quantidade não é somada entre produtos");
    assert.equal((await preco(FORROS[0], 7)).unit_price_cents, 300);
    assert.equal((await preco(FORROS[1], 9)).unit_price_cents, 300);
    assert.equal((await preco(FORROS[0], 12)).unit_price_cents, 250);
  });

  it("reserva com duas linhas do grupo calcula cada linha separadamente", async () => {
    await criarGrupo({ produtos: [FORROS[0], FORROS[1]], faixas: [{ min: 5, max: null, preco: 300 }] });
    const { createReservation } = await carregar("src/app/(app)/reservas/actions.ts");
    await acao(() =>
      createReservation(
        null,
        fd({
          customer_id: String(CLIENTE),
          event_date: DENTRO,
          status: "pre_reserva",
          items: JSON.stringify([
            { product_id: String(FORROS[0]), qty: 3, unit_price_cents: NORMAL },
            { product_id: String(FORROS[1]), qty: 3, unit_price_cents: NORMAL },
          ]),
        }),
      ),
    );
    const itens = await todos(`SELECT * FROM reservation_items ORDER BY product_id`);
    assert.deepEqual(
      itens.map((i: any) => i.unit_price_cents),
      [NORMAL, NORMAL],
      "3 + 3 não alcança a faixa de 5 de nenhum produto",
    );
  });
});

/* ------------------------------------------------------------------ */
/* E — período de validade                                            */
/* ------------------------------------------------------------------ */

describe("E — período de validade", () => {
  beforeEach(cenario);

  it("antes, durante e depois do período", async () => {
    await criarGrupo({
      produtos: FORROS,
      faixas: [{ min: 5, max: null, preco: 300 }],
      inicio: "2026-12-01",
      fim: "2026-12-31",
    });
    assert.equal((await preco(FORROS[0], 5, "2026-11-30")).unit_price_cents, NORMAL, "dia anterior");
    assert.equal((await preco(FORROS[0], 5, "2026-12-01")).unit_price_cents, 300, "primeiro dia vale");
    assert.equal((await preco(FORROS[0], 5, "2026-12-31")).unit_price_cents, 300, "último dia vale");
    assert.equal((await preco(FORROS[0], 5, "2027-01-01")).unit_price_cents, NORMAL, "depois do fim");
  });

  it("o servidor aceita o preço promocional só dentro da vigência", async () => {
    await criarGrupo({
      produtos: FORROS,
      faixas: [{ min: 5, max: null, preco: 300 }],
      inicio: "2026-12-01",
      fim: "2026-12-31",
    });
    const { createQuote } = await carregar("src/app/(app)/orcamentos/actions.ts");
    const lancar = (data: string) =>
      acao(() =>
        createQuote(
          null,
          fd({
            customer_id: String(CLIENTE),
            event_date: data,
            event_time: "10:00",
            status: "rascunho",
            items: JSON.stringify([{ product_id: String(FORROS[0]), qty: 5, unit_price_cents: NORMAL }]),
          }),
        ),
      );

    await lancar("2026-11-30");
    assert.equal((await um(`SELECT * FROM quote_items ORDER BY id DESC LIMIT 1`)).unit_price_cents, NORMAL);
    await lancar("2026-12-15");
    assert.equal((await um(`SELECT * FROM quote_items ORDER BY id DESC LIMIT 1`)).unit_price_cents, 300);
    await lancar("2027-01-05");
    assert.equal((await um(`SELECT * FROM quote_items ORDER BY id DESC LIMIT 1`)).unit_price_cents, NORMAL);
  });
});

/* ------------------------------------------------------------------ */
/* F — conflito entre promoção individual e grupo                     */
/* ------------------------------------------------------------------ */

describe("F — conflito de promoções", () => {
  beforeEach(cenario);

  it("recusa o grupo quando um produto já tem promoção sobreposta, sem gravar nada", async () => {
    const individual = await criarIndividual(FORROS[2], [{ min: 5, max: null, preco: 350 }]);
    const m = await carregar("src/app/(app)/promocoes/actions.ts");
    const erro = await m.createPromotion(
      null,
      fd({
        name: "Grupo que briga",
        tiers: tiers([{ min: 5, max: null, preco: 300 }]),
        active: "1",
        starts_on: "",
        ends_on: "",
        product_ids: JSON.stringify(FORROS),
      }),
    );

    assert.match(String(erro), /Forro vermelho/i, "a mensagem diz qual produto está em conflito");
    assert.match(String(erro), /já existe outra promoção/i);
    assert.equal(
      Number((await um(`SELECT COUNT(*) AS n FROM promotion_groups`)).n),
      0,
      "nenhum grupo foi criado",
    );
    assert.equal(
      Number((await um(`SELECT COUNT(*) AS n FROM promotions WHERE group_id IS NOT NULL`)).n),
      0,
      "nenhum membro de grupo foi gravado",
    );
    assert.equal((await preco(FORROS[2], 5)).unit_price_cents, 350, "a promoção individual continua valendo");
    assert.ok(individual);
  });

  it("autoriza quando os períodos não se cruzam", async () => {
    await criarIndividual(FORROS[0], [{ min: 5, max: null, preco: 350 }], {
      inicio: "2026-09-01",
      fim: "2026-09-30",
    });
    const url = await criarGrupo({
      produtos: FORROS,
      faixas: [{ min: 5, max: null, preco: 300 }],
      inicio: "2026-12-01",
      fim: "2026-12-31",
    });
    assert.ok(url.startsWith("/promocoes/grupo/"), `esperava grupo, veio: ${url}`);
    assert.equal((await preco(FORROS[0], 5, "2026-09-15")).unit_price_cents, 350);
    assert.equal((await preco(FORROS[0], 5, DENTRO)).unit_price_cents, 300);
  });
});

/* ------------------------------------------------------------------ */
/* G — orçamentos e reservas novos                                    */
/* ------------------------------------------------------------------ */

describe("G — orçamentos e reservas", () => {
  beforeEach(cenario);

  it("orçamento mistura grupo, individual e produto sem promoção", async () => {
    await criarGrupo({ produtos: FORROS, faixas: [{ min: 5, max: null, preco: 300 }] });
    await criarIndividual(KIT, [{ min: 1, max: null, preco: 1800 }]);

    const { createQuote } = await carregar("src/app/(app)/orcamentos/actions.ts");
    await acao(() =>
      createQuote(
        null,
        fd({
          customer_id: String(CLIENTE),
          event_date: DENTRO,
          event_time: "10:00",
          status: "rascunho",
          items: JSON.stringify([
            { product_id: String(FORROS[0]), qty: 5, unit_price_cents: NORMAL },
            { product_id: String(FORROS[1]), qty: 12, unit_price_cents: NORMAL },
            { product_id: String(KIT), qty: 1, unit_price_cents: 2000 },
          ]),
        }),
      ),
    );

    const itens = await todos(`SELECT * FROM quote_items ORDER BY product_id`);
    // ordem por product_id: KIT (960), forro branco (961), forro azul (962)
    assert.deepEqual(itens.map((i: any) => i.unit_price_cents), [1800, 300, 300]);
    const cotacao = await um(`SELECT * FROM quotes ORDER BY id DESC LIMIT 1`);
    assert.equal(cotacao.total_cents, 1500 + 3600 + 1800);
  });

  it("reserva direta aplica a mesma regra do grupo", async () => {
    await criarGrupo({ produtos: [FORROS[0], FORROS[1], FORROS[2]], faixas: [{ min: 5, max: null, preco: 300 }] });
    await criarIndividual(FORROS[3], [{ min: 1, max: null, preco: 400 }]);
    const { createReservation } = await carregar("src/app/(app)/reservas/actions.ts");
    await acao(() =>
      createReservation(
        null,
        fd({
          customer_id: String(CLIENTE),
          event_date: DENTRO,
          status: "pre_reserva",
          items: JSON.stringify([
            { product_id: String(FORROS[0]), qty: 5, unit_price_cents: NORMAL },
            { product_id: String(FORROS[3]), qty: 2, unit_price_cents: NORMAL },
            { product_id: String(FORROS[4]), qty: 5, unit_price_cents: NORMAL },
          ]),
        }),
      ),
    );
    const itens = await todos(`SELECT * FROM reservation_items ORDER BY product_id`);
    assert.deepEqual(
      itens.map((i: any) => i.unit_price_cents),
      [300, 400, NORMAL],
      "grupo, individual e produto sem promoção, cada um com a sua regra",
    );
    const reserva = await um(`SELECT * FROM reservations ORDER BY id DESC LIMIT 1`);
    assert.equal(reserva.total_cents, 1500 + 800 + 2500);
  });
});

/* ------------------------------------------------------------------ */
/* H — documento já salvo não muda                                    */
/* ------------------------------------------------------------------ */

describe("H — histórico preservado", () => {
  beforeEach(cenario);

  it("reserva criada antes do grupo mantém preço e total", async () => {
    const { createReservation } = await carregar("src/app/(app)/reservas/actions.ts");
    await acao(() =>
      createReservation(
        null,
        fd({
          customer_id: String(CLIENTE),
          event_date: DENTRO,
          status: "pre_reserva",
          items: JSON.stringify([{ product_id: String(FORROS[0]), qty: 5, unit_price_cents: NORMAL }]),
        }),
      ),
    );
    const antes = await um(`SELECT * FROM reservations ORDER BY id DESC LIMIT 1`);
    const itemAntes = await um(`SELECT * FROM reservation_items WHERE reservation_id = ?`, [antes.id]);
    assert.equal(itemAntes.unit_price_cents, NORMAL);

    await criarGrupo({ produtos: FORROS, faixas: [{ min: 5, max: null, preco: 300 }] });

    const depois = await um(`SELECT * FROM reservations WHERE id = ?`, [antes.id]);
    const itemDepois = await um(`SELECT * FROM reservation_items WHERE reservation_id = ?`, [antes.id]);
    assert.equal(itemDepois.unit_price_cents, NORMAL, "promoção nova não reescreve linha gravada");
    assert.equal(depois.total_cents, antes.total_cents, "total da reserva intacto");
    assert.equal(antes.total_cents, 2500);
  });

  it("excluir o grupo não altera documento já salvo", async () => {
    const groupId = idDaUrl(await criarGrupo({ produtos: FORROS, faixas: [{ min: 5, max: null, preco: 300 }] }));
    const { createReservation } = await carregar("src/app/(app)/reservas/actions.ts");
    await acao(() =>
      createReservation(
        null,
        fd({
          customer_id: String(CLIENTE),
          event_date: DENTRO,
          status: "pre_reserva",
          items: JSON.stringify([{ product_id: String(FORROS[0]), qty: 5, unit_price_cents: NORMAL }]),
        }),
      ),
    );
    const reserva = await um(`SELECT * FROM reservations ORDER BY id DESC LIMIT 1`);
    assert.equal(reserva.total_cents, 1500);

    const m = await carregar("src/app/(app)/promocoes/actions.ts");
    const url = await acao(() => m.deleteGroupPromotion(fd({ id: String(groupId) })));
    assert.equal(url, "/promocoes");
    assert.equal((await membrosDoGrupo(groupId)).length, 0, "linhas do grupo removidas");
    assert.equal((await um(`SELECT * FROM promotion_groups WHERE id = ?`, [groupId])), undefined);
    const salva = await um(`SELECT * FROM reservations WHERE id = ?`, [reserva.id]);
    assert.equal(salva.total_cents, 1500, "documento preservado");
  });
});

/* ------------------------------------------------------------------ */
/* I — edição do grupo                                                */
/* ------------------------------------------------------------------ */

describe("I — edição do grupo", () => {
  beforeEach(cenario);

  it("adicionar e remover produtos afeta só o grupo", async () => {
    const mantidos = [FORROS[0], FORROS[1], FORROS[2]];
    const groupId = idDaUrl(await criarGrupo({ produtos: mantidos, faixas: [{ min: 5, max: null, preco: 300 }] }));
    // promoção que NÃO faz parte deste grupo
    await criarIndividual(KIT, [{ min: 1, max: null, preco: 1800 }], { nome: "Promo do kit" });
    const promoKit = await um(`SELECT * FROM promotions WHERE product_id = ?`, [KIT]);

    const novoConjunto = [FORROS[0], FORROS[1], FORROS[3]];
    const url = await editarGrupo({
      groupId,
      produtos: novoConjunto,
      faixas: [{ min: 5, max: null, preco: 250 }],
      nome: "Forros revisados",
    });
    assert.equal(url, `/promocoes/grupo/${groupId}`);

    const membros = await membrosDoGrupo(groupId);
    assert.deepEqual(membros.map((m: any) => m.product_id), novoConjunto);
    assert.equal((await um(`SELECT * FROM promotion_groups WHERE id = ?`, [groupId])).name, "Forros revisados");

    for (const produto of novoConjunto) {
      assert.equal((await preco(produto, 5)).unit_price_cents, 250, `forro ${produto} recebeu a regra nova`);
    }
    assert.equal((await preco(FORROS[2], 5)).unit_price_cents, NORMAL, "produto removido volta ao preço normal");
    assert.equal(
      (await todos(`SELECT * FROM promotions WHERE product_id = ?`, [FORROS[2]])).length,
      0,
      "a linha do removido foi apagada, não desativada",
    );
    assert.equal((await preco(FORROS[4], 5)).unit_price_cents, NORMAL, "produto nunca selecionado intacto");

    const kitDepois = await um(`SELECT * FROM promotions WHERE id = ?`, [promoKit.id]);
    assert.ok(kitDepois, "promoção individual de outro produto continua existindo");
    assert.equal(kitDepois.group_id, null);
    assert.equal((await preco(KIT, 1)).unit_price_cents, 1800);
  });

  it("recusa adicionar ao grupo um produto com promoção individual sobreposta", async () => {
    const groupId = idDaUrl(await criarGrupo({ produtos: [FORROS[0], FORROS[1]], faixas: [{ min: 5, max: null, preco: 300 }] }));
    await criarIndividual(FORROS[4], [{ min: 5, max: null, preco: 380 }]);

    const m = await carregar("src/app/(app)/promocoes/actions.ts");
    const erro = await m.updateGroupPromotion(
      null,
      fd({
        group_id: String(groupId),
        name: "Grupo com conflito",
        tiers: tiers([{ min: 5, max: null, preco: 250 }]),
        active: "1",
        starts_on: "",
        ends_on: "",
        product_ids: JSON.stringify([FORROS[0], FORROS[1], FORROS[4]]),
      }),
    );
    assert.match(String(erro), /Forro verde/i);
    assert.match(String(erro), /já existe outra promoção/i);

    const membros = await membrosDoGrupo(groupId);
    assert.deepEqual(membros.map((m2: any) => m2.product_id), [FORROS[0], FORROS[1]], "grupo não mudou");
    assert.equal((await preco(FORROS[0], 5)).unit_price_cents, 300, "regra anterior preservada");
    assert.equal((await preco(FORROS[4], 5)).unit_price_cents, 380, "promoção individual preservada");
  });

  it("membro de grupo não é editado pela tela individual", async () => {
    const groupId = idDaUrl(await criarGrupo({ produtos: FORROS, faixas: [{ min: 5, max: null, preco: 300 }] }));
    const membro = (await membrosDoGrupo(groupId))[0];
    const m = await carregar("src/app/(app)/promocoes/actions.ts");
    const erro = await m.updatePromotion(
      null,
      fd({
        id: String(membro.id),
        product_id: String(membro.product_id),
        name: "Tentativa isolada",
        tiers: tiers([{ min: 5, max: null, preco: 100 }]),
        active: "1",
        starts_on: "",
        ends_on: "",
      }),
    );
    assert.match(String(erro), /promoção em grupo/i);
    assert.equal((await preco(membro.product_id, 5)).unit_price_cents, 300);
  });

  it("promoção individual vira grupo quando o operador seleciona mais produtos", async () => {
    const url = await criarIndividual(FORROS[0], [{ min: 5, max: null, preco: 300 }], { nome: "Vira grupo" });
    const id = idDaUrl(url);
    const m = await carregar("src/app/(app)/promocoes/actions.ts");
    const destino = await acao(() =>
      m.updatePromotion(
        null,
        fd({
          id: String(id),
          product_ids: JSON.stringify([FORROS[0], FORROS[1]]),
          name: "Vira grupo",
          tiers: tiers([{ min: 5, max: null, preco: 280 }]),
          active: "1",
          starts_on: "",
          ends_on: "",
        }),
      ),
    );
    assert.ok(destino.startsWith("/promocoes/grupo/"), `redirect inesperado: ${destino}`);
    const groupId = idDaUrl(destino);
    assert.equal(
      (await um(`SELECT * FROM promotions WHERE id = ?`, [id])).id,
      id,
      "a linha original é reaproveitada (histórico preservado)",
    );
    assert.equal((await membrosDoGrupo(groupId)).length, 2);
    assert.equal((await preco(FORROS[1], 5)).unit_price_cents, 280);
  });
});
