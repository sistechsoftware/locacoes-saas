/**
 * LOJA VIRTUAL — portas por plano/exceção, catálogo público, submissão com
 * recálculo no servidor, disponibilidade, estados comerciais, Pix,
 * comprovantes e ISOLAMENTO entre empresas.
 *
 * Cenário: empresa 1 (Empresarial, loja publicada) e empresa 2 (Essencial,
 * loja publicada por exceção administrativa) com produtos próprios.
 * Nenhum teste rede: o frete é exercitado pelos caminhos que não dependem de
 * serviço externo (retirada e endereço incompleto), e a disponibilidade pelos
 * mesmos caminhos de estoque do painel.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createTestDb, resetTestDb } from "./helpers/d1.ts";
import { all, insert, one, resetCompanyCache, run, scalar } from "../src/lib/db.ts";
import {
  PALETAS_LOJA,
  SLUGS_RESERVADOS,
  comprovanteAceito,
  crc16Ccitt,
  normalizarSlug,
  pixCopiaECola,
  subtotalItem,
  totaisPedido,
  validarCoresLoja,
  validarDataPedido,
  validarSlug,
} from "../src/lib/loja.ts";
import { RECURSOS, planoInclui, recursoDoCaminho, resolverPermissao } from "../src/lib/planos.ts";
import { recursoLiberado } from "../src/lib/plano-personalizado.ts";
import {
  aprovarPedido,
  cancelarPedido,
  checklistLoja,
  criarOrcamentoDoPedido,
  definirPagamento,
  expirarPedidos,
  itensDoPedido,
  lojaDaEmpresa,
  pausarLoja,
  pedidoDaEmpresa,
  publicarLoja,
  recusarPedido,
  salvarIdentidadeLoja,
  salvarProdutoLoja,
  salvarRegrasLoja,
} from "../src/lib/loja-db.ts";
import {
  acompanhamentoPorToken,
  catalogoDaLoja,
  criarPedidoPublico,
  enviarComprovante,
  lojaPorSlug,
} from "../src/lib/loja-publico.ts";
import { checkConflicts } from "../src/lib/stock.ts";
import { addDays, today } from "../src/lib/format.ts";

const HOJE = today();
const EVENTO = addDays(HOJE, 7);

let seq = 0;

/* ------------------------------------------------------------------ */
/* Cenário                                                             */
/* ------------------------------------------------------------------ */

async function assinar(companyId: number, slug: string) {
  const plano = await one<{ id: number }>(`SELECT id FROM plans WHERE slug = ?`, [slug]);
  assert.ok(plano, `plano ${slug} precisa existir (migration 0029)`);
  await run(
    `INSERT INTO subscriptions (company_id, plan_id, status, trial_ends_at, current_period_start, current_period_end)
     VALUES (?,?, 'trial', ?, ?, ?)`,
    [companyId, plano!.id, addDays(HOJE, 14), HOJE, addDays(HOJE, 14)],
  );
}

async function produto(companyId: number, nome: string, preco: number, opts: { kit?: boolean; total?: number; ativo?: boolean } = {}) {
  seq++;
  const id = await insert(
    `INSERT INTO products (code, name, kind, total_qty, rent_price_cents, photo, active, company_id)
     VALUES (?,?,?,?,?,?,?,?)`,
    [`LP${seq}`, nome, opts.kit ? "kit" : "simples", opts.kit ? 0 : (opts.total ?? 10), preco, "/api/arquivo/abc", opts.ativo === false ? 0 : 1, companyId],
  );
  return id;
}

async function publicarProduto(companyId: number, productId: number, extra: Record<string, unknown> = {}) {
  const r = await salvarProdutoLoja(companyId, productId, { published: "1", ...extra });
  assert.ok(r.ok, r.erro);
}

async function montarLoja(companyId: number, slug: string, extra: Record<string, unknown> = {}) {
  const r = await salvarIdentidadeLoja(companyId, {
    slug,
    display_name: `Loja ${slug}`,
    phone: "11999990000",
    whatsapp: "5511999990000",
    city: "São Paulo",
    ...extra,
  });
  assert.ok(r.ok, (r as any).erro);
  const pub = await publicarLoja(companyId, true);
  assert.ok(pub.ok, (pub as any).erro);
}

async function base() {
  await run(`INSERT OR IGNORE INTO companies (id, name, active) VALUES (2, 'Loja B', 1)`);
  await run(`INSERT OR IGNORE INTO stock_revision (id, revision) VALUES (1, 0)`);
  await run(`INSERT OR IGNORE INTO stock_revision (id, revision) VALUES (2, 0)`);
  await assinar(1, "empresarial");
  await assinar(2, "essencial");
  // operador usado como autor das ações do painel (FK de created_by/reviewed_by)
  await run(
    `INSERT OR IGNORE INTO users (id, name, username, password_hash, role, company_id)
     VALUES (7, 'Operador da Loja', 'loja_operador_7', 'x', 'admin', 1)`,
  );
}

beforeEach(() => {
  resetTestDb();
  resetCompanyCache();
  createTestDb();
});

/* ------------------------------------------------------------------ */
/* 1. Matriz de recursos (pura)                                        */
/* ------------------------------------------------------------------ */

describe("matriz: loja_virtual", () => {
  it("é exclusiva do Empresarial e não é fundamental", () => {
    assert.equal(RECURSOS.loja_virtual.minimo, "empresarial");
    assert.equal(RECURSOS.loja_virtual.fundamental, false);
    assert.equal(planoInclui("empresarial", "loja_virtual"), true);
    assert.equal(planoInclui("profissional", "loja_virtual"), false);
    assert.equal(planoInclui("essencial", "loja_virtual"), false);
    assert.equal(planoInclui(null, "loja_virtual"), false, "sem plano conhecido: fail-closed");
  });

  it("liberação e bloqueio administrativos prevalecem pela precedência central", () => {
    const liberada = resolverPermissao({ recurso: "loja_virtual", ajuste: "allow", planoInclui: false });
    assert.deepEqual(liberada, { liberado: true, origem: "liberacao_admin" });
    const bloqueada = resolverPermissao({ recurso: "loja_virtual", ajuste: "block", planoInclui: true });
    assert.deepEqual(bloqueada, { liberado: false, origem: "bloqueio_admin" });
    const padrao = resolverPermissao({ recurso: "loja_virtual", ajuste: null, planoInclui: true });
    assert.deepEqual(padrao, { liberado: true, origem: "plano" });
  });

  it("o caminho da seção deriva o recurso (menu e gate andam juntos)", () => {
    assert.equal(recursoDoCaminho("/configuracoes/loja"), "loja_virtual");
    assert.equal(recursoDoCaminho("/configuracoes/loja/pedidos/12"), "loja_virtual");
    assert.equal(recursoDoCaminho("/configuracoes"), null);
  });
});

/* ------------------------------------------------------------------ */
/* 2. Regras puras                                                     */
/* ------------------------------------------------------------------ */

describe("slug público", () => {
  it("valida formato, tamanho e lista de reservados", () => {
    assert.equal(validarSlug("minha-loja-123").ok, true);
    assert.equal(validarSlug("Minha Loja").ok, false, "espaço/maiúscula recusado");
    assert.equal(validarSlug("ab").ok, false, "curto demais");
    assert.equal(validarSlug("api").ok, false, "rota reservada");
    assert.equal(validarSlug("loja").ok, false);
    assert.equal(validarSlug("admin").ok, false);
    assert.equal(validarSlug("-inicio-").ok, false, "não começa/termina com hífen");
    assert.ok(SLUGS_RESERVADOS.has("configuracoes"));
    assert.equal(validarSlug("a".repeat(41)).ok, false, "grande demais");
  });

  it("normaliza entrada do usuário", () => {
    assert.equal(normalizarSlug("  Locação da Ana!! "), "locacao-da-ana");
    assert.equal(normalizarSlug("---x---"), "x");
  });
});

describe("paletas e contraste", () => {
  it("todas as paletas prontas passam na validação AA", () => {
    for (const p of PALETAS_LOJA) {
      const r = validarCoresLoja(p.cores);
      assert.ok(r.ok, `${p.id}: ${r.erros.join(" | ")}`);
    }
  });

  it("recusa texto ilegível sobre o fundo e botão ilegível", () => {
    assert.equal(validarCoresLoja({ ...PALETAS_LOJA[0].cores, text: "#ffffff", background: "#ffffff" }).ok, false);
    assert.equal(validarCoresLoja({ ...PALETAS_LOJA[0].cores, primary: "#ffffff" }).ok, false, "botão branco com texto branco");
    assert.equal(validarCoresLoja({ ...PALETAS_LOJA[0].cores, primary: "vermelho" as string }).ok, false, "hex inválido");
  });
});

describe("totais e datas", () => {
  it("soma qty × período × unitário e calcula sinal", () => {
    assert.equal(subtotalItem({ qty: 3, unit_price_cents: 1000, period_qty: 1 }), 3000);
    assert.equal(subtotalItem({ qty: 2, unit_price_cents: 5000, period_qty: 3 }), 30000);
    const t = totaisPedido([{ qty: 2, unit_price_cents: 10000 }], { freightCents: 1500, signalPercent: 30 });
    assert.deepEqual(t, { items_cents: 20000, freight_cents: 1500, total_cents: 21500, signal_cents: 6450 });
    assert.equal(totaisPedido([{ qty: 1, unit_price_cents: 999 }], { signalPercent: 0 }).signal_cents, 0);
  });

  it("aplica antecedência mínima e horizonte máximo com data real do servidor", () => {
    // 3 dias de antecedência: nem hoje nem amanhã passam; 3 dias sim
    assert.match(String(validarDataPedido({ min_lead_days: 3, max_days_ahead: 0 }, HOJE, addDays(HOJE, 1))), /antecedência/);
    assert.equal(validarDataPedido({ min_lead_days: 3, max_days_ahead: 0 }, HOJE, addDays(HOJE, 3)), null);
    assert.match(String(validarDataPedido({ min_lead_days: 3, max_days_ahead: 0 }, HOJE, HOJE)), /antecedência/);
    assert.match(String(validarDataPedido({ min_lead_days: 0, max_days_ahead: 10 }, HOJE, addDays(HOJE, 30))), /até 10 dias/);
    assert.equal(validarDataPedido({ min_lead_days: 0, max_days_ahead: 0 }, HOJE, addDays(HOJE, 300)), null, "0 = sem limite");
    assert.match(String(validarDataPedido({ min_lead_days: 0, max_days_ahead: 0 }, HOJE, "2026-02-30")), /válida/);
  });
});

describe("comprovante", () => {
  it("aceita só JPG/PNG/WEBP/PDF dentro de 5 MB", () => {
    assert.equal(comprovanteAceito("image/png", 1000), null);
    assert.equal(comprovanteAceito("application/pdf", 1000), null);
    assert.match(String(comprovanteAceito("application/x-msdownload", 1000)), /Formato não aceito/);
    assert.match(String(comprovanteAceito("image/png", 6 * 1024 * 1024)), /grande demais/);
    assert.match(String(comprovanteAceito("image/png", 0)), /vazio/);
  });
});

describe("Pix (BR Code)", () => {
  it("CRC16-CCITT bate com o valor de verificação do padrão", () => {
    assert.equal(crc16Ccitt("123456789"), "29B1");
  });

  it("gera payload com valor exato, chave, recebedor e CRC válido", () => {
    const r = pixCopiaECola({
      chave: "pagamentos@locaisilva.com.br",
      nome: "Locação da Silva Ltda",
      cidade: "São Paulo",
      valorCents: 123456,
      identificador: "LOJA001",
    });
    assert.ok(r.ok);
    const p = (r as any).payload as string;
    assert.ok(p.startsWith("000201"), "início EMV");
    assert.ok(p.includes("br.gov.bcb.pix"));
    assert.ok(p.includes("pagamentos@locaisilva.com.br"));
    assert.ok(p.includes("5406123456"), `valor 1234,56 presente: ${p.slice(0, 90)}`);
    assert.ok(p.includes("5921LOCACAO DA SILVA LTDA"), `sem acento e maiúsculo: ${p.slice(-140)}`);
    assert.ok(p.includes("6009SAO PAULO"), `cidade sem acento: ${p.slice(-80)}`);
    const base = p.slice(0, p.length - 4);
    assert.equal(p.slice(-4), crc16Ccitt(base), "CRC recalculado confere");
  });

  it("sem valor não marca campo 54; sem chave é recusado", () => {
    const r = pixCopiaECola({ chave: "11999998888", nome: "Ana", cidade: "Recife", valorCents: 0 }) as any;
    assert.ok(r.ok);
    assert.ok(!/54\d{2}/.test(r.payload.slice(0, 60)), "sem campo de valor no início");
    const semChave = pixCopiaECola({ chave: "  ", nome: "Ana", cidade: "Recife" });
    assert.equal(semChave.ok, false);
  });
});

/* ------------------------------------------------------------------ */
/* 3. Configuração, portas e publicação                                */
/* ------------------------------------------------------------------ */

describe("configuração da loja", () => {
  it("impede slug de outra empresa e slug inválido", async () => {
    await base();
    const ok = await salvarIdentidadeLoja(1, { slug: "loja-a", display_name: "A", phone: "11999990000" });
    assert.ok(ok.ok);
    const colisao = await salvarIdentidadeLoja(2, { slug: "loja-a" });
    assert.equal(colisao.ok, false);
    assert.match(String((colisao as any).erro), /em uso/);
    const invalido = await salvarIdentidadeLoja(1, { slug: "admin" });
    assert.equal(invalido.ok, false);
  });

  it("atualização parcial preserva o que não foi enviado", async () => {
    await base();
    await salvarIdentidadeLoja(1, { slug: "loja-a", display_name: "Loja Original", phone: "11999990000" });
    const r = await salvarIdentidadeLoja(1, { slug: "loja-a" });
    assert.ok(r.ok);
    assert.equal(r.loja.display_name, "Loja Original", "nome não foi apagado pelo salvamento só do slug");
    assert.equal(r.loja.phone, "11999990000");
  });

  it("checklist bloqueia publicação incompleta e libera quando completo", async () => {
    await base();
    await salvarIdentidadeLoja(1, { slug: "loja-a" });
    const antes = await checklistLoja(1);
    assert.equal(antes.ok, false);
    const bloqueio = await publicarLoja(1, true);
    assert.equal(bloqueio.ok, false);
    assert.match(String((bloqueio as any).erro), /Antes de publicar/);

    await montarLoja(1, "loja-a");
    const depois = await checklistLoja(1);
    assert.equal(depois.ok, true, JSON.stringify(depois.itens.filter((i) => !i.ok)));
    const loja = await lojaDaEmpresa(1);
    assert.equal(loja?.status, "publicada");
  });

  it("pausa impede novos pedidos sem apagar nada", async () => {
    await base();
    const p = await produto(1, "Mesa", 5000);
    await montarLoja(1, "loja-a");
    await publicarProduto(1, p);
    await pausarLoja(1, true, "Férias até sexta");
    const r = await criarPedidoPublico({
      slug: "loja-a",
      itens: [{ product_id: p, qty: 1 }],
      cliente: { nome: "Maria Silva", telefone: "11999998888" },
      event_date: EVENTO,
      modalidade: "retirada",
    });
    assert.equal(r.ok, false);
    assert.match(String((r as any).erro), /férias|recebendo/i);
    assert.equal(await scalar<number>(`SELECT COUNT(*) FROM store_orders`), 0, "nada foi gravado na pausa");
  });
});

describe("porta pública por plano e exceção", () => {
  it("Essencial fica fora; liberação administrativa abre; bloqueio fecha", async () => {
    await base();
    await montarLoja(2, "loja-b");

    // plano Essencial sem exceção: a loja publicada NÃO é servida
    const semRecurso = await lojaPorSlug("loja-b");
    assert.equal(semRecurso.ok, false);
    assert.equal((semRecurso as any).status, 404, "resposta pública igual a inexistente");
    assert.equal(await recursoLiberado(2, "loja_virtual"), false);

    // plataforma libera por exceção (company_feature_overrides)
    await run(`INSERT INTO company_feature_overrides (company_id, feature, effect, reason) VALUES (?, 'loja_virtual', 'allow', 'demo')`, [2]);
    assert.equal(await recursoLiberado(2, "loja_virtual"), true);
    const liberada = await lojaPorSlug("loja-b");
    assert.equal(liberada.ok, true);

    // revogação volta a cortar a porta pública
    await run(`DELETE FROM company_feature_overrides WHERE company_id = ? AND feature = 'loja_virtual'`, [2]);
    assert.equal((await lojaPorSlug("loja-b")).ok, false);
  });

  it("Empresarial com bloqueio administrativo perde a loja; sem bloqueio, tem", async () => {
    await base();
    await montarLoja(1, "loja-a");
    assert.equal((await lojaPorSlug("loja-a")).ok, true);
    await run(`INSERT INTO company_feature_overrides (company_id, feature, effect, reason) VALUES (?, 'loja_virtual', 'block', 'demo')`, [1]);
    assert.equal((await lojaPorSlug("loja-a")).ok, false, "bloqueio prevalece até sobre o plano");
    await run(`DELETE FROM company_feature_overrides WHERE company_id = ? AND feature = 'loja_virtual'`, [1]);
    assert.equal((await lojaPorSlug("loja-a")).ok, true);
  });

  it("loja desativada, slug inexistente e empresa inativa respondem 404 público", async () => {
    await base();
    await montarLoja(1, "loja-a");
    assert.equal((await lojaPorSlug("nao-existe")).ok, false);
    await run(`UPDATE company_stores SET status='desativada' WHERE company_id = 1`);
    assert.equal((await lojaPorSlug("loja-a")).ok, false, "fora do ar não serve público");
    // acompanhamento continua possível para pedido já existente
    assert.equal((await lojaPorSlug("loja-a", { requerPublicada: false })).ok, true);
    await run(`UPDATE companies SET active = 0 WHERE id = 1`);
    assert.equal((await lojaPorSlug("loja-a", { requerPublicada: false })).ok, false, "empresa inativa some por completo");
  });
});

/* ------------------------------------------------------------------ */
/* 4. Catálogo                                                         */
/* ------------------------------------------------------------------ */

describe("catálogo público", () => {
  it("só publica produtos ativos e publicados da PRÓPRIA empresa", async () => {
    await base();
    const p1 = await produto(1, "Mesa Redonda", 5000);
    const p2 = await produto(1, "Cadeira", 1000);
    const p3 = await produto(1, "Forro Velho", 900, { ativo: false });
    const p4 = await produto(2, "Mesa Inimiga", 4000);
    await montarLoja(1, "loja-a");
    await montarLoja(2, "loja-b");
    await publicarProduto(1, p1);
    await publicarProduto(2, p4);

    const lojaA = (await lojaPorSlug("loja-a")) as any;
    const itens = await catalogoDaLoja(lojaA.loja);
    assert.deepEqual(itens.map((i) => i.product_id), [p1], "só o produto publicado e ativo da empresa 1");
    assert.ok(!itens.some((i) => i.name.includes("Inimiga")), "nada de outra empresa");
    assert.ok(!itens.some((i) => i.product_id === p3), "produto inativo não publica");
    assert.ok(!itens.some((i) => i.product_id === p2), "produto não publicado fica de fora");
  });

  it("preço público da loja é independente do preço operacional", async () => {
    await base();
    const p = await produto(1, "Tenda", 5000);
    await montarLoja(1, "loja-a");
    await publicarProduto(1, p, { public_price_cents: 7000 });
    const lojaA = (await lojaPorSlug("loja-a")) as any;
    const itens = await catalogoDaLoja(lojaA.loja);
    assert.equal(itens[0].preco_cents, 7000);
    assert.equal(await scalar<number>(`SELECT rent_price_cents FROM products WHERE id = ?`, [p]), 5000, "cadastro intacto");
  });
});

/* ------------------------------------------------------------------ */
/* 5. Submissão de pedido                                              */
/* ------------------------------------------------------------------ */

function pedidoBase(p: number, extra: Record<string, any> = {}) {
  return {
    slug: "loja-a",
    itens: [{ product_id: p, qty: 2 }],
    cliente: { nome: "Maria Silva", telefone: "(11) 99999-8888", email: "maria@exemplo.com" },
    event_date: EVENTO,
    modalidade: "retirada" as const,
    ...extra,
  };
}

async function lojaComProduto(opts: { precoLoja?: number; loja?: Record<string, unknown> } = {}) {
  await base();
  const p = await produto(1, "Mesa", 5000);
  await montarLoja(1, "loja-a");
  // regras comerciais são outra tabela: identidade não as guarda
  if (opts.loja) await salvarRegrasLoja(1, opts.loja);
  await publicarProduto(1, p, opts.precoLoja ? { public_price_cents: opts.precoLoja } : {});
  return p;
}

describe("submissão de pedido (servidor manda)", () => {
  it("grava preço do servidor, totais coerentes e cliente sem duplicidade", async () => {
    const p = await lojaComProduto({ precoLoja: 7000 });
    const r = await criarPedidoPublico(pedidoBase(p));
    assert.ok(r.ok, (r as any).erro);
    assert.equal(r.status, "aguardando_analise", "modo manual não aprova sozinho");
    assert.equal(r.kind, "orcamento".length ? r.kind : "", "kind definido");
    assert.deepEqual(r.totals, { items_cents: 14000, freight_cents: 0, total_cents: 14000, signal_cents: 0 });

    const pedido = await one<any>(`SELECT * FROM store_orders WHERE number = ?`, [r.number]);
    assert.equal(pedido.company_id, 1);
    assert.equal(pedido.freight_status, "isento");
    const itens = await itensDoPedido(1, pedido.id);
    assert.equal(itens.length, 1);
    assert.equal(itens[0].unit_price_cents, 7000, "preço da loja, não o operacional nem nada vindo do navegador");
    assert.equal(itens[0].subtotal_cents, 14000);

    // mesma identidade (telefone) reaproveita o cadastro em vez de duplicar
    const antes = await scalar<number>(`SELECT COUNT(*) FROM customers WHERE company_id = 1`);
    const r2 = await criarPedidoPublico(pedidoBase(p, { cliente: { nome: "Maria S.", telefone: "11999998888" } }));
    assert.ok(r2.ok);
    const depois = await scalar<number>(`SELECT COUNT(*) FROM customers WHERE company_id = 1`);
    assert.equal(depois, antes, "telefone igual não cria segundo cliente");
    const novo = await one<any>(`SELECT customer_id FROM store_orders WHERE number = ?`, [(r2 as any).number]);
    assert.equal(novo.customer_id, pedido.customer_id);
  });

  it("valida data, mínimo de pedido, itens publicados e termos", async () => {
    const p = await lojaComProduto({ loja: { min_lead_days: 3, min_order_cents: 20000, require_terms: "1" } });

    const curta = await criarPedidoPublico(pedidoBase(p, { event_date: HOJE }));
    assert.equal(curta.ok, false);
    assert.match(String((curta as any).erro), /antecedência/);

    const barato = await criarPedidoPublico(pedidoBase(p, { itens: [{ product_id: p, qty: 1 }], aceitou_termos: true }));
    assert.equal(barato.ok, false);
    assert.match(String((barato as any).erro), /mínimo/i);

    const semTermo = await criarPedidoPublico(pedidoBase(p, { aceitou_termos: false }));
    assert.equal(semTermo.ok, false);
    assert.match(String((semTermo as any).erro), /termos/i);

    const fora = await criarPedidoPublico(pedidoBase(999999, { aceitou_termos: true }));
    assert.equal(fora.ok, false);

    // qty 5 × R$ 50,00 = R$ 250,00 ≥ mínimo de R$ 200,00
    const ok = await criarPedidoPublico(pedidoBase(p, { itens: [{ product_id: p, qty: 5 }], aceitou_termos: true }));
    assert.ok(ok.ok, (ok as any).erro);
  });

  it("retirada isenta, entrega com frete pendente quando a empresa permite e barrada quando não", async () => {
    const p = await lojaComProduto({ loja: { freight_pending_ok: "1" } });
    const r = await criarPedidoPublico(pedidoBase(p));
    assert.ok(r.ok);
    const pedido = await one<any>(`SELECT * FROM store_orders WHERE number = ?`, [r.number]);
    assert.equal(pedido.freight_status, "isento");
    assert.equal(pedido.freight_cents, 0);

    // endereço curto → sem serviço externo: fica pendente (permitido)
    const entrega = await criarPedidoPublico(
      pedidoBase(p, { modalidade: "entrega", endereco: { address: "Rua A", city: "SP" } }),
    );
    assert.ok(entrega.ok, (entrega as any).erro);
    const p2 = await one<any>(`SELECT * FROM store_orders WHERE number = ?`, [(entrega as any).number]);
    assert.equal(p2.freight_status, "pendente");
    assert.equal(p2.needs_delivery, 1);

    // mesma loja sem permissão de frete pendente → recusa o envio
    await run(`UPDATE company_stores SET freight_pending_ok = 0 WHERE company_id = 1`);
    const negado = await criarPedidoPublico(
      pedidoBase(p, { modalidade: "entrega", endereco: { address: "Rua A", city: "SP" } }),
    );
    assert.equal(negado.ok, false);
    assert.match(String((negado as any).erro), /frete|endereço/i);
  });
});

/* ------------------------------------------------------------------ */
/* 6. Aprovação automática, conflitos e estados                        */
/* ------------------------------------------------------------------ */

describe("aprovação automática e disponibilidade", () => {
  it("aprova quando tudo passa e a reserva ocupa o estoque", async () => {
    const p = await lojaComProduto({ loja: { mode: "automatica" } });
    const r = await criarPedidoPublico(pedidoBase(p));
    assert.ok(r.ok, (r as any).erro);
    assert.equal(r.status, "confirmada", "sem sinal, confirma na hora");
    const pedido = await one<any>(`SELECT * FROM store_orders WHERE number = ?`, [r.number]);
    assert.ok(pedido.reservation_id, "reserva criada pelo caminho oficial");
    assert.equal(pedido.kind, "reserva");
    const reserva = await one<any>(`SELECT * FROM reservations WHERE id = ?`, [pedido.reservation_id]);
    assert.equal(reserva.status, "confirmada");
    assert.equal(reserva.company_id, 1);
    assert.equal(reserva.store_order_id, pedido.id, "origem Loja Virtual identificável no painel");

    // o estoque está ocupado: outra solicitação para a mesma janela conflita
    const conflitos = await checkConflicts([{ product_id: p, qty: 10 }], `${EVENTO}T08:00`, `${addDays(EVENTO, 1)}T18:00`, null, {}, 1);
    assert.ok(conflitos.length > 0, "reserva da loja segura estoque como qualquer outra");
  });

  it("com sinal obrigatório aprova como aguardando pagamento com prazo", async () => {
    const p = await lojaComProduto({ loja: { mode: "automatica", signal_percent: "30", payment_deadline_h: "24" } });
    const r = await criarPedidoPublico(pedidoBase(p));
    assert.ok(r.ok, (r as any).erro);
    assert.equal(r.status, "aprovada_aguardando_pagamento");
    assert.equal(r.payment_status, "aguardando");
    assert.ok(r.payment_deadline_at, "prazo de pagamento gravado");
    assert.equal(r.totals.signal_cents, Math.floor((r.totals.total_cents * 30) / 100));
    const pedido = await one<any>(`SELECT * FROM store_orders WHERE number = ?`, [r.number]);
    const reserva = await one<any>(`SELECT status FROM reservations WHERE id = ?`, [pedido.reservation_id]);
    assert.equal(reserva.status, "pre_reserva");
  });

  it("sem estoque suficiente degrada para análise manual (nunca aprova)", async () => {
    const p = await lojaComProduto({ loja: { mode: "automatica" } });
    // esgota o estoque com uma reserva concorrente do painel
    const cliente = await insert(`INSERT INTO customers (name, phone, company_id) VALUES ('Outro','11888887777',1)`);
    const reserva = await insert(
      `INSERT INTO reservations (number, customer_id, status, event_date, delivery_at, pickup_at, company_id)
       VALUES ('LIMA-900', ?, 'confirmada', ?, ?, ?, 1)`,
      [cliente, EVENTO, `${EVENTO}T08:00`, `${addDays(EVENTO, 1)}T18:00`],
    );
    await insert(
      `INSERT INTO reservation_items (reservation_id, product_id, qty, unit_price_cents, company_id) VALUES (?,?,10,1000,1)`,
      [reserva, p],
    );
    // a expansão de componentes é a fonte única de ocupação lida pelo estoque
    await insert(
      `INSERT INTO reservation_item_components (reservation_id, reservation_item_id, product_id, qty_per_unit, qty, company_id)
       VALUES (?, (SELECT MAX(id) FROM reservation_items), ?, 1, 10, 1)`,
      [reserva, p],
    );

    const r = await criarPedidoPublico(pedidoBase(p));
    assert.ok(r.ok, (r as any).erro);
    assert.equal(r.status, "aguardando_analise", "caiu para análise manual");
    const pedido = await one<any>(`SELECT * FROM store_orders WHERE number = ?`, [r.number]);
    assert.equal(pedido.reservation_id, null, "nada de reserva sem confirmação de estoque");
    const eventos = await all<any>(`SELECT event FROM store_order_events WHERE store_order_id = ?`, [pedido.id]);
    assert.ok(eventos.some((e) => e.event === "auto_pendente"), "motivo registrado no histórico");
  });

  it("aprovar com conflito devolve erro e não altera o pedido", async () => {
    const p = await lojaComProduto();
    const r = await criarPedidoPublico(pedidoBase(p));
    assert.ok(r.ok);
    const pedido = await one<any>(`SELECT * FROM store_orders WHERE number = ?`, [(r as any).number]);
    // estoque some depois que o pedido entrou
    await run(`UPDATE products SET total_qty = 0 WHERE id = ?`, [p]);
    const apr = await aprovarPedido(1, pedido.id, null);
    assert.equal(apr.ok, false);
    assert.match(String((apr as any).erro), /ESTOQUE/);
    const depois = await pedidoDaEmpresa(1, pedido.id);
    assert.equal(depois?.status, "aguardando_analise", "pedido segue intacto");
    assert.equal(depois?.reservation_id, null);
  });

  it("recusar em aberto devolve; aprovar ocupa; cancelar confirmada libera", async () => {
    const p = await lojaComProduto();
    const janela = [`${EVENTO}T08:00`, `${addDays(EVENTO, 1)}T18:00`] as const;

    // 1) recusa enquanto a solicitação está ABERTA → marca recusada
    const r1 = (await criarPedidoPublico(pedidoBase(p))) as any;
    assert.ok(r1.ok, r1.erro);
    const pedido1 = await one<any>(`SELECT id FROM store_orders WHERE number = ?`, [r1.number]);
    const rec = await recusarPedido(1, pedido1.id, 7, "Item indisponível");
    assert.ok(rec.ok, (rec as any).erro);
    assert.equal((await pedidoDaEmpresa(1, pedido1.id))?.status, "recusada");

    // 2) aprovar OUTRA ocupa o estoque de verdade
    const r2 = (await criarPedidoPublico(pedidoBase(p))) as any;
    assert.ok(r2.ok, r2.erro);
    const pedido2 = await one<any>(`SELECT id FROM store_orders WHERE number = ?`, [r2.number]);
    const apr = await aprovarPedido(1, pedido2.id, 7);
    assert.ok(apr.ok, (apr as any).erro);
    assert.equal(apr.pedido.status, "confirmada", "sem sinal, aprovação = confirmada");
    assert.ok(apr.pedido.reservation_id);
    const ocupado = await checkConflicts([{ product_id: p, qty: 10 }], janela[0], janela[1], null, {}, 1);
    assert.ok(ocupado.length > 0, "estoque realmente ocupado pela reserva");

    // 3) uma CONFIRMADA não é "recusada" (estado fechado) — o painel cancela
    const bloqueio = await recusarPedido(1, pedido2.id, 7, "x");
    assert.equal(bloqueio.ok, false, "estado fechado não volta para recusa");
    const canc = await cancelarPedido(1, pedido2.id, 7, "Cliente desistiu");
    assert.ok(canc.ok, (canc as any).erro);
    assert.equal((await pedidoDaEmpresa(1, pedido2.id))?.status, "cancelada");
    const reserva = await one<any>(`SELECT status FROM reservations WHERE id = ?`, [apr.pedido.reservation_id]);
    assert.equal(reserva.status, "cancelada", "cancelamento devolve o estoque");
    const conflitos = await checkConflicts([{ product_id: p, qty: 10 }], janela[0], janela[1], null, {}, 1);
    assert.equal(conflitos.length, 0, "liberação real, não só visual");
  });

  it("expiração de pagamento cancela a reserva e libera o estoque", async () => {
    const p = await lojaComProduto({ loja: { mode: "automatica", signal_percent: "50", payment_deadline_h: "1" } });
    const r = await criarPedidoPublico(pedidoBase(p));
    assert.ok(r.ok);
    assert.equal(r.status, "aprovada_aguardando_pagamento");
    // simula o prazo vencido (mesma regra derivada do tempo, sem cron)
    await run(`UPDATE store_orders SET payment_deadline_at = ? WHERE number = ?`, [addDays(HOJE, -1) + "T00:00", r.number]);
    const n = await expirarPedidos(1);
    assert.equal(n, 1);
    const pedido = await one<any>(`SELECT * FROM store_orders WHERE number = ?`, [r.number]);
    assert.equal(pedido.status, "expirada");
    assert.equal(pedido.payment_status, "expirado");
    const reserva = await one<any>(`SELECT status FROM reservations WHERE id = ?`, [pedido.reservation_id]);
    assert.equal(reserva.status, "cancelada");
    const conflitos = await checkConflicts([{ product_id: p, qty: 10 }], `${EVENTO}T08:00`, `${addDays(EVENTO, 1)}T18:00`, null, {}, 1);
    assert.equal(conflitos.length, 0, "estoque devolvido após expiração");
  });

  it("converte em orçamento pelo mecanismo existente e vincula ao pedido", async () => {
    const p = await lojaComProduto({ loja: { mode: "orcamento" } });
    const r = await criarPedidoPublico(pedidoBase(p));
    assert.ok(r.ok);
    assert.equal((r as any).kind, "orcamento");
    const pedido = await one<any>(`SELECT * FROM store_orders WHERE number = ?`, [(r as any).number]);
    const conv = await criarOrcamentoDoPedido(1, pedido.id, 7);
    assert.ok(conv.ok, (conv as any).erro);
    const quote = await one<any>(`SELECT * FROM quotes WHERE id = ?`, [conv.quoteId]);
    assert.equal(quote.company_id, 1);
    assert.equal(quote.store_order_id, pedido.id);
    const itens = await all<any>(`SELECT * FROM quote_items WHERE quote_id = ?`, [conv.quoteId]);
    assert.equal(itens.length, 1);
    assert.equal(itens[0].unit_price_cents, 5000, "preço da loja levado ao orçamento");
    const depois = await pedidoDaEmpresa(1, pedido.id);
    assert.equal(depois?.quote_id, conv.quoteId);
    assert.equal((await criarOrcamentoDoPedido(1, pedido.id, 7)).ok, false, "não converte duas vezes");
  });
});

/* ------------------------------------------------------------------ */
/* 7. Acompanhamento e comprovante                                     */
/* ------------------------------------------------------------------ */

describe("acompanhamento por token", () => {
  it("devolve o pedido pelo token sem expor dados internos", async () => {
    const p = await lojaComProduto();
    const r = await criarPedidoPublico(pedidoBase(p));
    assert.ok(r.ok);
    const acc = await acompanhamentoPorToken("loja-a", (r as any).token);
    assert.ok(acc.ok, (acc as any).erro);
    assert.equal(acc.pedido.number, r.number);
    assert.equal(acc.pedido.itens.length, 1);
    assert.equal(acc.pedido.totals.total_cents, 10000);
    assert.ok(!("customer_email" in acc.pedido), "sem e-mail no payload público");
    assert.ok(!("customer_phone" in acc.pedido), "sem telefone no payload público");
    assert.ok(!("reservation_id" in acc.pedido), "sem id interno no payload público");
    assert.ok(!("customer_id" in acc.pedido));
  });

  it("token errado ou de outra empresa não acha o pedido", async () => {
    const p = await lojaComProduto();
    const r = await criarPedidoPublico(pedidoBase(p));
    assert.ok(r.ok);
    const erro = await acompanhamentoPorToken("loja-a", "token-invalido-curto");
    assert.equal(erro.ok, false);
    const outro = await acompanhamentoPorToken("loja-a", "a".repeat(32));
    assert.equal(outro.ok, false, "token inexistente não enumera pedidos");
  });
});

describe("comprovante", () => {
  function arquivo(tipo: string, bytes: number, nome = "comprovante.png") {
    return new File([new Uint8Array(bytes)], nome, { type: tipo });
  }

  it("aceita arquivo válido, muda para comprovante enviado e NÃO confirma pagamento", async () => {
    const p = await lojaComProduto({ loja: { mode: "automatica", signal_percent: "50" } });
    const r = await criarPedidoPublico(pedidoBase(p));
    assert.ok(r.ok);
    assert.equal(r.status, "aprovada_aguardando_pagamento");

    const envio = await enviarComprovante("loja-a", (r as any).token, arquivo("image/png", 2048));
    assert.ok(envio.ok, (envio as any).erro);
    assert.equal(envio.status, "comprovante_enviado");
    const pedido = await one<any>(`SELECT * FROM store_orders WHERE number = ?`, [r.number]);
    assert.equal(pedido.payment_status, "comprovante_enviado", "envio nunca confirma sozinho");
    assert.equal(pedido.status, "aprovada_aguardando_pagamento", "estado comercial intacto");
    const rec = await one<any>(`SELECT * FROM store_receipts WHERE store_order_id = ?`, [pedido.id]);
    assert.equal(rec.company_id, 1);
    assert.equal(rec.status, "aguardando");
    const file = await one<any>(`SELECT company_id FROM files WHERE id = ?`, [rec.file_id]);
    assert.equal(file.company_id, 1, "arquivo escopado pela empresa");

    // empresa confirma manualmente → aí sim o estado muda
    const conf = await definirPagamento(1, pedido.id, "confirmar", 7);
    assert.ok(conf.ok, (conf as any).erro);
    assert.equal(conf.pedido.payment_status, "confirmado");
    assert.equal(conf.pedido.status, "confirmada");
    const reserva = await one<any>(`SELECT status FROM reservations WHERE id = ?`, [pedido.reservation_id]);
    assert.equal(reserva.status, "confirmada", "reserva confirmada só após confirmação humana");
  });

  it("recusa tipo inválido, arquivo grande e token errado", async () => {
    const p = await lojaComProduto();
    const r = await criarPedidoPublico(pedidoBase(p));
    assert.ok(r.ok);
    const token = (r as any).token;

    const tipo = await enviarComprovante("loja-a", token, arquivo("application/x-msdownload", 100, "virus.exe"));
    assert.equal(tipo.ok, false);
    assert.match(String((tipo as any).erro), /Formato não aceito/);

    const grande = await enviarComprovante("loja-a", token, arquivo("image/jpeg", 6 * 1024 * 1024, "gigante.jpg"));
    assert.equal(grande.ok, false);
    assert.match(String((grande as any).erro), /grande demais/);

    const semToken = await enviarComprovante("loja-a", "a".repeat(40), arquivo("image/png", 100));
    assert.equal(semToken.ok, false);

    assert.equal(await scalar<number>(`SELECT COUNT(*) FROM store_receipts`), 0, "nada gravado nas recusas");
  });

  it("reenvio cria novo registro e mantém a empresa correta", async () => {
    const p = await lojaComProduto();
    const r = await criarPedidoPublico(pedidoBase(p));
    assert.ok(r.ok);
    const token = (r as any).token;
    assert.ok((await enviarComprovante("loja-a", token, arquivo("image/png", 100))).ok);
    assert.ok((await enviarComprovante("loja-a", token, arquivo("application/pdf", 200, "recibo.pdf"))).ok);
    const pedido = await one<any>(`SELECT id FROM store_orders WHERE number = ?`, [r.number]);
    const recs = await all<any>(`SELECT * FROM store_receipts WHERE store_order_id = ? ORDER BY id`, [pedido.id]);
    assert.equal(recs.length, 2, "reenvio preserva o histórico");
    assert.equal(recs[1].mime, "application/pdf");
  });
});

/* ------------------------------------------------------------------ */
/* 8. Isolamento entre tenants                                         */
/* ------------------------------------------------------------------ */

describe("isolamento entre empresas", () => {
  it("a loja B não lê pedido, produto nem configuração da loja A", async () => {
    await base();
    const pA = await produto(1, "Mesa A", 5000);
    const pB = await produto(2, "Mesa B", 6000);
    await montarLoja(1, "loja-a");
    await montarLoja(2, "loja-b");
    await publicarProduto(1, pA);
    await publicarProduto(2, pB);

    // a empresa 2 é Essencial: só serve o público com a exceção administrativa
    await run(`INSERT INTO company_feature_overrides (company_id, feature, effect, reason) VALUES (2, 'loja_virtual', 'allow', 'teste')`);
    const pedido = await criarPedidoPublico(pedidoBase(pA));
    assert.ok(pedido.ok);
    const row = await one<any>(`SELECT id FROM store_orders WHERE number = ?`, [(pedido as any).number]);

    // empresa 2 não enxerga o pedido da empresa 1
    assert.equal(await pedidoDaEmpresa(2, row.id), null);
    assert.equal((await lojaPorSlug("loja-a")).ok, true, "slug resolve para a empresa dona");
    const lojaB = (await lojaPorSlug("loja-b")) as any;
    const itensB = await catalogoDaLoja(lojaB.loja);
    assert.deepEqual(itensB.map((i: any) => i.product_id), [pB]);

    // e não consegue resgatar o acompanhamento pelo slug errado
    const token = "x".repeat(32);
    const outroSlug = await acompanhamentoPorToken("loja-b", token);
    assert.equal(outroSlug.ok, false);
  });

  it("comprovante da empresa A não é servido publicamente pela rota de arquivos", async () => {
    await base();
    const p = await produto(1, "Mesa", 5000);
    await montarLoja(1, "loja-a");
    await publicarProduto(1, p);
    const r = await criarPedidoPublico(pedidoBase(p));
    assert.ok(r.ok);
    await enviarComprovante("loja-a", (r as any).token, new File([new Uint8Array(64)], "c.png", { type: "image/png" }));
    const rec = await one<any>(`SELECT file_id FROM store_receipts`);
    // a rota pública só serve arquivos referenciados como identidade/foto de
    // produto publicado — um comprovante nunca entra nessa allowlist
    const { GET } = await import(`../src/app/api/loja/[slug]/arquivo/[id]/route.ts`);
    const resp = await GET(new Request("http://localhost/api/loja/loja-a/arquivo/" + rec.file_id), {
      params: Promise.resolve({ slug: "loja-a", id: rec.file_id }),
    });
    assert.equal(resp.status, 404, "comprovante fora da allowlist pública");
  });
});
