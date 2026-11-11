import "server-only";
import { all } from "./db";
import { precoPromocional, type Promocao } from "./promocoes";
import { promocoesAtivasAgrupadas } from "./promocoes-db";

/**
 * Preço comercial aplicado numa linha de reserva/orçamento.
 *
 * Duas decisões moram aqui:
 *
 *  1. CRIAÇÃO (precificarItensNovos) — o módulo de promoções continua mandando:
 *     o servidor resolve a promoção vigente na data da locação e cobra o preço
 *     dela, salvo quando o operador digitou um valor a mão.
 *
 *  2. EDIÇÃO (precificarItensDaEdicao) — o preço GRAVADO manda. Uma linha que
 *     já existia nunca é reprecificada por promoção nova, por alteração de faixa
 *     ou por mudança de data; promoções só entram em linha nova. Preço alterado
 *     pelo operador vira `manual` e fica registrado como negociação.
 *
 * A origem (normal/promocao/manual) e os valores de auditoria (catálogo e
 * promoção calculada) são gravados junto da linha, para que reabrir o documento
 * saiba exatamente o que era regra e o que era acordo.
 *
 * Este arquivo não altera a regra de promoções (lib/promocoes.ts): ele apenas a
 * consome e decide SE ela pode ser aplicada naquele momento.
 */

export type OrigemPreco = "normal" | "promocao" | "manual";

export type ItemComOrigem = {
  product_id: number;
  qty: number;
  unit_price_cents: number;
  /** Preço digitado a mão no formulário (precedência sobre a promoção). */
  preco_manual?: boolean | null;
  /** Origem informada pelo formulário, quando a linha nasceu nesta edição. */
  price_source?: OrigemPreco | string | null;
  base_price_cents?: number | null;
  promo_unit_price_cents?: number | null;
  promotion_id?: number | null;
};

/** Linha já persistida — a fonte de verdade ao reabrir o documento. */
export type LinhaGravada = {
  product_id: number;
  unit_price_cents: number;
  price_source?: string | null;
  base_price_cents?: number | null;
  promo_unit_price_cents?: number | null;
  promotion_id?: number | null;
};

type Contexto = {
  /** Preço de catálogo por produto (auditoria do valor original). */
  catalogo: Map<number, number>;
  /** Todas as promoções ativas do produto, por produto. */
  promocoes: Map<number, Promocao[]>;
};

async function contexto(companyId: number): Promise<Contexto> {
  const [produtos, promocoes] = await Promise.all([
    all<{ id: number; rent_price_cents: number }>(
      `SELECT id, rent_price_cents FROM products WHERE company_id = ?`,
      [companyId],
    ),
    promocoesAtivasAgrupadas(companyId),
  ]);
  return {
    catalogo: new Map(produtos.map((p) => [p.id, Number(p.rent_price_cents) || 0])),
    promocoes,
  };
}

/**
 * Melhor promoção para a linha, com o id — a regra pura (precoPromocional)
 * decide vigência e faixa; aqui só guardamos QUEM deu o preço, para auditoria.
 */
function melhorPromocao(candidatas: Promocao[], qty: number, dia: string) {
  let melhor: { unit_price_cents: number; id: number } | null = null;
  for (const p of candidatas) {
    const r = precoPromocional(p, qty, dia);
    if (r && (!melhor || r.unit_price_cents < melhor.unit_price_cents)) {
      melhor = { unit_price_cents: r.unit_price_cents, id: p.id };
    }
  }
  return melhor;
}

/** Origem declarada, já validada — lixo de qualquer origem vira null. */
function origemDeclarada(i: ItemComOrigem): OrigemPreco | null {
  if (i.preco_manual === true) return "manual";
  const s = i.price_source;
  return s === "normal" || s === "promocao" || s === "manual" ? s : null;
}

/** Preço de uma linha NOVA: promoção manda, salvo negociação explícita. */
function precificarItem<T extends ItemComOrigem>(item: T, ctx: Contexto, dia: string): T {
  const catalogo = ctx.catalogo.get(item.product_id) ?? 0;
  const promo = melhorPromocao(ctx.promocoes.get(item.product_id) ?? [], item.qty, dia);
  const auditoria = {
    base_price_cents: catalogo,
    promo_unit_price_cents: promo?.unit_price_cents ?? null,
    promotion_id: promo?.id ?? null,
  };
  const declarada = origemDeclarada(item);

  // preço digitado a mão: preservado; a promoção calculada fica só na auditoria
  if (declarada === "manual") {
    return { ...item, price_source: "manual", ...auditoria };
  }
  // promoção aplicada explicitamente pelo operador e conferida pelo servidor
  if (declarada === "promocao" && promo && promo.unit_price_cents === item.unit_price_cents) {
    return { ...item, price_source: "promocao", ...auditoria };
  }
  // regra normal: promoção vigente cobre a quantidade nesta data
  if (promo) {
    return { ...item, unit_price_cents: promo.unit_price_cents, price_source: "promocao", ...auditoria };
  }
  // sem promoção aplicável: valor de catálogo é 'normal'; diferente disso é
  // negociação (evita rotular como catálogo um preço que ninguém digitou igual)
  return {
    ...item,
    price_source: item.unit_price_cents === catalogo ? "normal" : "manual",
    ...auditoria,
  };
}

/**
 * Precifica as linhas de um documento NOVO. O servidor é a autoridade: consulta
 * as promoções vigentes na data da locação e grava a origem de cada preço.
 */
export async function precificarItensNovos<T extends ItemComOrigem>(
  itens: T[],
  dataISO: string,
  companyId: number,
): Promise<T[]> {
  if (!itens.length) return itens;
  const ctx = await contexto(companyId);
  const dia = String(dataISO ?? "").slice(0, 10);
  return itens.map((i) => precificarItem(i, ctx, dia));
}

/**
 * Precifica as linhas de um documento JÁ CRIADO.
 *
 * Regra de ouro: linha que já existe mantém preço, origem e auditoria gravados.
 * Nenhuma promoção — nova, alterada ou que passou a valer — é reaplicada sobre
 * o que foi combinado com o cliente. Só linha nova (produto que entrou agora)
 * passa pela regra vigente; e preço alterado pelo operador é registrado como
 * negociação manual, preservando o novo valor.
 */
export async function precificarItensDaEdicao<T extends ItemComOrigem>(
  itens: T[],
  gravadas: LinhaGravada[],
  dataISO: string,
  companyId: number,
): Promise<T[]> {
  if (!itens.length) return itens;
  const ctx = await contexto(companyId);
  const dia = String(dataISO ?? "").slice(0, 10);
  // o editor trabalha com uma linha por produto; a primeira gravada é a régua
  const porProduto = new Map<number, LinhaGravada>();
  for (const l of gravadas) {
    if (!porProduto.has(l.product_id)) porProduto.set(l.product_id, l);
  }

  return itens.map((item) => {
    const gravada = porProduto.get(item.product_id);

    // produto que entrou agora: mesma regra da criação
    if (!gravada) return precificarItem(item, ctx, dia);

    // preço inalterado: o que está gravado manda, inclusive a origem. Linha
    // anterior à migração 0053 tem origem NULL e continua NULL (desconhecida).
    if (Number(item.unit_price_cents) === Number(gravada.unit_price_cents)) {
      return {
        ...item,
        unit_price_cents: Number(gravada.unit_price_cents),
        price_source: gravada.price_source ?? null,
        base_price_cents: gravada.base_price_cents ?? null,
        promo_unit_price_cents: gravada.promo_unit_price_cents ?? null,
        promotion_id: gravada.promotion_id ?? null,
      };
    }

    const promo = melhorPromocao(ctx.promocoes.get(item.product_id) ?? [], item.qty, dia);
    const catalogo = ctx.catalogo.get(item.product_id) ?? 0;
    const declarada = origemDeclarada(item);

    // volta EXPLÍCITA à promoção (o operador desfez a exceção no editor): o
    // servidor confere contra a regra vigente antes de aceitar o rótulo
    if (declarada === "promocao" && promo && promo.unit_price_cents === Number(item.unit_price_cents)) {
      return {
        ...item,
        unit_price_cents: promo.unit_price_cents,
        price_source: "promocao",
        base_price_cents: catalogo || gravada.base_price_cents || 0,
        promo_unit_price_cents: promo.unit_price_cents,
        promotion_id: promo.id,
      };
    }

    // volta EXPLÍCITA ao preço de catálogo, quando não há promoção aplicável
    if (declarada === "normal" && !promo && Number(item.unit_price_cents) === catalogo) {
      return {
        ...item,
        unit_price_cents: catalogo,
        price_source: "normal",
        base_price_cents: catalogo,
        promo_unit_price_cents: null,
        promotion_id: null,
      };
    }

    // preço alterado sem pedido de volta à regra: negociação manual — preservada,
    // com a auditoria (catálogo e promoção calculada) ao lado
    return {
      ...item,
      unit_price_cents: Number(item.unit_price_cents),
      price_source: "manual",
      base_price_cents: gravada.base_price_cents ?? catalogo,
      promo_unit_price_cents: promo?.unit_price_cents ?? gravada.promo_unit_price_cents ?? null,
      promotion_id: promo?.id ?? gravada.promotion_id ?? null,
    };
  });
}
