"use client";
import { useEffect, useMemo, useState } from "react";
import { diasCobrados, money, parseMoney, today } from "@/lib/format";
import { descontoDePct, exprDePct, pctDeExpr, pctDigitado, type ModoDesconto } from "@/lib/desconto";
import { precoPromocional, precoUnitarioEntre, rotuloFaixa, type Promocao } from "@/lib/promocoes";
import { Icon } from "./Icons";
import MoneyInput from "./MoneyInput";

export type Product = {
  id: number;
  code: string;
  name: string;
  category: string | null;
  rent_price_cents: number;
  total_qty: number;
  kind?: "simples" | "kit" | string;
  /** Resumo da composicao do kit ("1 Mesa + 4 Cadeira"). */
  composition?: string | null;
  /** Promocao por quantidade ativa deste produto, quando existir. */
  promocao?: Promocao | null;
  /**
   * TODAS as promocoes ativas do produto, na ordem do cadastro.
   *
   * Uma promocao so nao basta: o cadastro aceita duas promocoes do mesmo
   * produto em periodos diferentes (meses distintos) ou faixas de quantidade
   * diferentes (1 a 4 e 5+), e a regra escolhe entre elas pela data da
   * locacao e pela quantidade da linha.
   */
  promocoes?: Promocao[];
  /**
   * Modalidade de cobranca RESOLVIDA (produto > default da empresa > fixo).
   * 'diaria': o valor digitado é por diária e a linha multiplica pelos dias
   * de calendário da janela; 'fixo': comportamento atual, sem período.
   */
  pricing_mode?: "fixo" | "diaria" | string | null;
};

export type ItemRow = {
  product_id: number;
  qty: number;
  unit_price_cents: number;
  discount_cents: number;
  /** Forma do desconto ("10%" ou ausente = R$) — só exibição, migração 0046. */
  discount_expr?: string | null;
  /**
   * O operador digitou este preco a mao?
   *
   * Enquanto for automatico, mudar a quantidade recalcula pela promocao. Depois
   * que alguem digita um valor, o sistema para de mexer: sobrescrever o que a
   * pessoa acabou de escrever seria pior que nao ter promocao nenhuma.
   */
  preco_manual?: boolean;
  /**
   * Origem do preço comercial (migração 0053): normal, promocao ou manual.
   * Linha antiga pode ter null = origem desconhecida.
   */
  price_source?: "normal" | "promocao" | "manual" | null;
  /** Preço de catálogo no momento da venda (auditoria). */
  base_price_cents?: number | null;
  /** Preço que a promoção dava no momento da venda (auditoria). */
  promo_unit_price_cents?: number | null;
  /** Promoção aplicada, quando existir. */
  promotion_id?: number | null;
  /**
   * Linha veio de um documento JÁ SALVO.
   *
   * Preço comercial preservado: reabrir o registro não reprecifica nada, e
   * nenhuma promoção nova/alterada entra por cima do que foi negociado. Para
   * trocar, o operador tem o botão explícito "Aplicar promoção" na linha.
   */
  preservado?: boolean;
};

export type StockInfo = Record<number, { available: number; requested: number; missing: number }>;

/** Última forma de desconto usada (R$ ou %) — mesma memória dos formulários. */
const CHAVE_DESCTO_MODO = "locacoes:desconto-modo";

/**
 * Períodos cobrados de uma linha: 'diaria' multiplica pelos dias de calendário
 * da janela (mínimo 1); qualquer outra modalidade cobra 1 — a fórmula antiga.
 * O servidor recalcula sozinho ao gravar (lib/pricing.ts); isto é só exibição.
 */
export function periodosDaLinha(
  modo: "fixo" | "diaria" | string | null | undefined,
  dias: number,
): number {
  return modo === "diaria" ? Math.max(1, dias) : 1;
}

/** Subtotal de uma linha com período — usado pelo editor e pelos formulários. */
export function subtotalLinha(
  i: { qty: number; unit_price_cents: number; discount_cents: number },
  modo: "fixo" | "diaria" | string | null | undefined,
  dias: number,
): number {
  return Math.max(0, i.qty * periodosDaLinha(modo, dias) * i.unit_price_cents - i.discount_cents);
}

/** Editor de itens compartilhado por reservas e orcamentos. */
export default function ItemsEditor({
  products,
  items,
  onChange,
  stock,
  dataReferencia,
  dias,
}: {
  products: Product[];
  items: ItemRow[];
  onChange: (items: ItemRow[]) => void;
  stock?: StockInfo;
  /**
   * Data que decide se a promocao esta vigente. Numa reserva e a data do
   * evento, nao a de hoje: quem fecha em setembro uma festa de novembro
   * precisa ver o preco de novembro.
   */
  dataReferencia?: string;
  /**
   * Dias de calendário da janela [entrega, retirada] — multiplicador das
   * linhas 'diaria'. Calculado pelo formulário com diasCobrados(); o servidor
   * recomputa da janela gravada, nunca confia neste valor.
   */
  dias?: number;
}) {
  const [picker, setPicker] = useState("");
  const [modoDesconto, setModoDesconto] = useState<ModoDesconto>("money");
  useEffect(() => {
    const m = window.localStorage.getItem(CHAVE_DESCTO_MODO);
    if (m === "money" || m === "percent") setModoDesconto(m);
  }, []);
  useEffect(() => {
    window.localStorage.setItem(CHAVE_DESCTO_MODO, modoDesconto);
  }, [modoDesconto]);
  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  /* Sem data escolhida, "hoje" no fuso do NEGOCIO (America/Sao_Paulo) — o
   * mesmo today() das telas de promocao. O toISOString() antigo era UTC: depois
   * das 21h de Brasilia ja era o dia seguinte, e a promocao caia fora da
   * vigencia (ou entrava) um dia adiantado. */
  const dia = dataReferencia?.slice(0, 10) || today();
  const janelaDias = Math.max(1, dias ?? 1);

  /** Promocoes candidatas desta linha: a lista completa ou a unica (legado). */
  const candidatasDe = (productId: number): Promocao[] => {
    const p = byId.get(productId);
    return p?.promocoes ?? (p?.promocao ? [p.promocao] : []);
  };

  /** Preco que a regra manda cobrar por esta linha, com a faixa que o justifica. */
  const calcular = (productId: number, qty: number) => {
    const p = byId.get(productId);
    return precoUnitarioEntre(p?.rent_price_cents ?? 0, candidatasDe(productId), qty, dia);
  };

  /**
   * Mesma conta de `calcular`, mas devolvendo QUAL promoção deu o preço — o id
   * é gravado junto da linha (auditoria da origem "promocao").
   */
  const promocaoDe = (productId: number, qty: number) => {
    const r = calcular(productId, qty);
    if (!r.promocional || !r.faixa) return { ...r, id: null as number | null };
    const escolhida = candidatasDe(productId).find((c) => {
      const pc = precoPromocional(c, qty, dia);
      return (
        pc?.unit_price_cents === r.unit_price_cents &&
        pc.faixa.min_qty === r.faixa!.min_qty &&
        pc.faixa.max_qty === r.faixa!.max_qty
      );
    });
    return { ...r, id: escolhida?.id ?? null };
  };

  /** Período cobrado por esta linha (1 para fixo). */
  const per = (productId: number) => periodosDaLinha(byId.get(productId)?.pricing_mode, janelaDias);

  // a promocao muda com a quantidade, entao o preco automatico e recalculado
  // quando a linha muda — mas SOMENTE em linha nascida nesta edição. Linha
  // vinda do banco (preservado) e linha com preco digitado a mao ficam intactas:
  // abrir e salvar um registro nunca troca o valor combinado com o cliente.
  useEffect(() => {
    let mudou = false;
    const ajustados = items.map((i) => {
      if (i.preco_manual || i.price_source === "manual" || i.preservado) return i;
      const alvo = promocaoDe(i.product_id, i.qty);
      if (alvo.unit_price_cents === i.unit_price_cents && alvo.promocional === (i.price_source === "promocao")) return i;
      mudou = true;
      return {
        ...i,
        unit_price_cents: alvo.unit_price_cents,
        price_source: alvo.promocional ? ("promocao" as const) : ("normal" as const),
        promo_unit_price_cents: alvo.promocional ? alvo.unit_price_cents : null,
        promotion_id: alvo.promocional ? alvo.id : null,
      };
    });
    if (mudou) onChange(ajustados);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, dia]);

  // Linha com desconto em %: o dinheiro gravado acompanha a base quando a
  // quantidade ou o preço muda — 10% de 3 mesas não pode continuar sendo
  // 10% de 1 mesa. Linha em R$ fica intacta, como sempre.
  useEffect(() => {
    let mudou = false;
    const ajustados = items.map((i) => {
      const pct = pctDeExpr(i.discount_expr);
      if (pct === null) return i;
      const base = i.qty * periodosDaLinha(byId.get(i.product_id)?.pricing_mode, janelaDias) * i.unit_price_cents;
      const cents = descontoDePct(base, pct);
      if (cents === i.discount_cents) return i;
      mudou = true;
      return { ...i, discount_cents: cents };
    });
    if (mudou) onChange(ajustados);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  const add = (productId: number) => {
    if (!productId) return;
    const p = byId.get(productId);
    if (!p) return;
    const preco = promocaoDe(productId, 1);
    const existing = items.find((i) => i.product_id === productId);
    if (existing) {
      onChange(items.map((i) => (i.product_id === productId ? { ...i, qty: i.qty + 1 } : i)));
    } else {
      onChange([
        ...items,
        {
          product_id: productId,
          qty: 1,
          unit_price_cents: preco.unit_price_cents,
          discount_cents: 0,
          discount_expr: null,
          price_source: preco.promocional ? ("promocao" as const) : ("normal" as const),
          base_price_cents: p.rent_price_cents,
          promo_unit_price_cents: preco.promocional ? preco.unit_price_cents : null,
          promotion_id: preco.promocional ? preco.id : null,
        },
      ]);
    }
    setPicker("");
  };

  const patch = (index: number, changes: Partial<ItemRow>) =>
    onChange(items.map((i, idx) => (idx === index ? { ...i, ...changes } : i)));

  const remove = (index: number) => onChange(items.filter((_, idx) => idx !== index));

  /** Texto inicial do campo de desconto: a forma GRAVADA manda; sem expressão,
   *  o valor existente é convertido para a forma atual (nada pula). */
  const valorDescontoLinha = (item: ItemRow, baseLinha: number, modo: ModoDesconto) => {
    const pct = pctDeExpr(item.discount_expr);
    if (modo === "percent") {
      if (pct !== null) return String(pct).replace(".", ",");
      if (item.discount_cents > 0 && baseLinha > 0) {
        const semeado = Math.min(100, Math.round((item.discount_cents / baseLinha) * 10000) / 100);
        return semeado > 0 ? String(semeado).replace(".", ",") : "";
      }
      return "";
    }
    return (item.discount_cents / 100).toFixed(2);
  };

  /** Blur do desconto: grava dinheiro e forma juntos, na mesma linha. */
  const aplicarDescontoLinha = (index: number, valor: string, baseLinha: number) => {
    const item = items[index];
    if (!item) return;
    if (modoDesconto === "percent") {
      if (valor.trim() === "") {
        if (item.discount_cents !== 0 || item.discount_expr) patch(index, { discount_cents: 0, discount_expr: null });
        return;
      }
      const pct = pctDigitado(valor);
      if (pct === null) return; // texto que não é percentual: mantém o anterior
      const cents = descontoDePct(baseLinha, pct);
      if (cents === item.discount_cents && exprDePct(pct) === item.discount_expr) return;
      patch(index, { discount_cents: cents, discount_expr: exprDePct(pct) });
      return;
    }
    const cents = parseMoney(valor);
    if (cents === item.discount_cents && !item.discount_expr) return;
    patch(index, { discount_cents: cents, discount_expr: null });
  };

  const subtotal = items.reduce(
    (s, i) => s + subtotalLinha(i, byId.get(i.product_id)?.pricing_mode, janelaDias),
    0,
  );

  const grouped = useMemo(() => {
    const g = new Map<string, Product[]>();
    for (const p of products) {
      const k = p.category ?? "Outros";
      g.set(k, [...(g.get(k) ?? []), p]);
    }
    return [...g.entries()];
  }, [products]);

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <select value={picker} onChange={(e) => add(Number(e.target.value))} className="campo flex-1">
          <option value="">+ Adicionar produto…</option>
          {grouped.map(([cat, list]) => (
            <optgroup key={cat} label={cat}>
              {list.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.kind === "kit" ? "[KIT] " : ""}
                  {p.name} · {money(p.rent_price_cents)}
                  {p.pricing_mode === "diaria" ? "/diária" : ""}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>

      {items.length > 0 && (
        <div className="flex items-center justify-between">
          <span className="text-[0.68rem] font-semibold uppercase text-stone-500">Descontos por item em</span>
          <div className="flex overflow-hidden rounded-xl border border-nuvem-300">
            <button
              type="button"
              onClick={() => setModoDesconto("money")}
              className={`px-3 py-1 text-xs font-bold ${modoDesconto === "money" ? "bg-marca-600 text-white" : "bg-white text-stone-500"}`}
            >
              R$
            </button>
            <button
              type="button"
              onClick={() => setModoDesconto("percent")}
              className={`px-3 py-1 text-xs font-bold ${modoDesconto === "percent" ? "bg-marca-600 text-white" : "bg-white text-stone-500"}`}
            >
              %
            </button>
          </div>
        </div>
      )}

      {items.length === 0 ? (
        <p className="rounded-xl border border-dashed border-nuvem-300 bg-nuvem-50 px-3 py-6 text-center text-sm text-stone-500">
          Nenhum item adicionado ainda.
        </p>
      ) : (
        <div className="space-y-2">
          {items.map((item, index) => {
            const p = byId.get(item.product_id);
            const info = stock?.[item.product_id];
            const per = periodosDaLinha(p?.pricing_mode, janelaDias);
            const line = subtotalLinha(item, p?.pricing_mode, janelaDias);
            const promo = promocaoDe(item.product_id, item.qty);
            const baseLinha = item.qty * per * item.unit_price_cents;
            /*
             * Linha já gravada que difere da regra atual: oferece a volta
             * EXPLÍCITA — inclusive quando a diferença veio de uma negociação
             * manual (a "exceção" que o operador fez). Sem promoção aplicável,
             * a volta é para o preço de catálogo. Nada é trocado sozinho.
             */
            const podeVoltarARegra =
              item.preservado === true &&
              promo.unit_price_cents !== item.unit_price_cents &&
              (promo.promocional || item.preco_manual === true);
            return (
              <div
                key={item.product_id}
                className={`rounded-xl border p-3 ${info ? "border-red-300 bg-red-50" : "border-nuvem-300 bg-white"}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="flex items-center gap-1.5 truncate text-sm font-bold text-tinta-900">
                      {p?.kind === "kit" && (
                        <span className="shrink-0 rounded bg-destaque-100 px-1.5 py-0.5 text-[0.6rem] font-bold uppercase text-destaque-700">
                          kit
                        </span>
                      )}
                      <span className="truncate">{p?.name ?? "Produto"}</span>
                    </p>
                    <p className="truncate text-xs text-stone-500">
                      {p?.kind === "kit"
                        ? p?.composition
                          ? `Consome ${p.composition} por unidade`
                          : "Kit sem composição definida"
                        : `${p?.code} · estoque total ${p?.total_qty}`}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => remove(index)}
                    className="rounded-lg p-1.5 text-red-600 hover:bg-red-100"
                    aria-label="Remover item"
                  >
                    <Icon name="fechar" className="h-4 w-4" />
                  </button>
                </div>

                <div className="mt-2 grid grid-cols-3 gap-2">
                  <label className="block">
                    <span className="mb-0.5 block text-[0.68rem] font-semibold uppercase text-stone-500">Qtd</span>
                    <div className="flex items-stretch overflow-hidden rounded-lg border border-nuvem-300 bg-white">
                      <button
                        type="button"
                        onClick={() => patch(index, { qty: Math.max(1, item.qty - 1) })}
                        className="px-2.5 text-lg font-bold text-stone-500"
                      >
                        -
                      </button>
                      <input
                        type="number"
                        min={1}
                        value={item.qty}
                        onChange={(e) => patch(index, { qty: Math.max(1, Number(e.target.value) || 1) })}
                        className="w-full min-w-0 border-x border-nuvem-200 px-1 py-2 text-center text-sm outline-none"
                      />
                      <button
                        type="button"
                        onClick={() => patch(index, { qty: item.qty + 1 })}
                        className="px-2.5 text-lg font-bold text-stone-500"
                      >
                        +
                      </button>
                    </div>
                  </label>

                  <label className="block">
                    <span className="mb-0.5 block text-[0.68rem] font-semibold uppercase text-stone-500">
                      {per > 1 ? "Valor/diária" : "Valor un."}
                    </span>
                    <MoneyInput
                      valueCents={item.unit_price_cents}
                      onCentsChange={(cents) => {
                        const digitado = cents ?? 0;
                        if (digitado === item.unit_price_cents) return;
                        // a partir daqui o preco e escolha da pessoa, nao da regra
                        patch(index, {
                          unit_price_cents: digitado,
                          preco_manual: true,
                          price_source: "manual",
                          preservado: false,
                        });
                      }}
                      className="w-full rounded-lg border border-nuvem-300 px-2 py-2 text-sm outline-none"
                    />
                  </label>

                  <label className="block">
                    <span className="mb-0.5 block text-[0.68rem] font-semibold uppercase text-stone-500">
                      Desconto {modoDesconto === "percent" ? "%" : "R$"}
                    </span>
                    {modoDesconto === "percent" ? (
                      <input
                        key={`desc-pct-${item.product_id}`}
                        defaultValue={valorDescontoLinha(item, baseLinha, "percent")}
                        onBlur={(e) => aplicarDescontoLinha(index, e.target.value, baseLinha)}
                        inputMode="decimal"
                        className="w-full rounded-lg border border-nuvem-300 px-2 py-2 text-sm outline-none"
                      />
                    ) : (
                      <MoneyInput
                        valueCents={item.discount_cents}
                        onCentsChange={(cents) => {
                          const valor = cents ?? 0;
                          if (valor === item.discount_cents && !item.discount_expr) return;
                          patch(index, { discount_cents: valor, discount_expr: null });
                        }}
                        className="w-full rounded-lg border border-nuvem-300 px-2 py-2 text-sm outline-none"
                      />
                    )}
                  </label>
                </div>

                {per > 1 && (
                  <p className="mt-2 rounded-lg bg-destaque-50 px-2 py-1.5 text-xs font-semibold text-destaque-700">
                    {item.qty} × {per} diárias × {money(item.unit_price_cents)} = {money(line)}
                  </p>
                )}
                {promo.promocional && !item.preco_manual && !item.preservado && (
                  <p className="mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 rounded-lg bg-emerald-50 px-2 py-1.5 text-xs text-emerald-800">
                    <span className="font-bold">Promoção aplicada</span>
                    <span>
                      {rotuloFaixa(promo.faixa!)}: {money(promo.unit_price_cents)} cada
                    </span>
                    {p && p.rent_price_cents > promo.unit_price_cents && (
                      <span className="text-emerald-700">
                        (normal <s>{money(p.rent_price_cents)}</s>, economia de{" "}
                        {money((p.rent_price_cents - promo.unit_price_cents) * item.qty * per)})
                      </span>
                    )}
                  </p>
                )}
                {/* Linha já gravada: o valor é o comercial, não a regra de hoje.
                    A promoção só entra se o operador pedir — nada é trocado sozinho. */}
                {podeVoltarARegra && (
                  <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-destaque-50 px-2 py-1.5 text-xs text-destaque-700">
                    <span>
                      {promo.promocional ? (
                        <>
                          Preço gravado: <strong>{money(item.unit_price_cents)}</strong>. Promoção vigente:{" "}
                          <strong>{money(promo.unit_price_cents)}</strong> cada.
                        </>
                      ) : (
                        <>
                          Preço gravado: <strong>{money(item.unit_price_cents)}</strong>. Preço de catálogo:{" "}
                          <strong>{money(promo.unit_price_cents)}</strong>.
                        </>
                      )}
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        patch(index, {
                          unit_price_cents: promo.unit_price_cents,
                          preco_manual: false,
                          price_source: promo.promocional ? "promocao" : "normal",
                          promo_unit_price_cents: promo.promocional ? promo.unit_price_cents : null,
                          promotion_id: promo.promocional ? promo.id : null,
                          preservado: false,
                        })
                      }
                      className="rounded-lg border border-destaque-300 bg-white px-2 py-1 font-bold"
                    >
                      {promo.promocional ? "Aplicar promoção" : "Voltar ao preço de catálogo"}
                    </button>
                  </div>
                )}
                {item.preco_manual && candidatasDe(item.product_id).length > 0 && (
                  <p className="mt-2 text-xs text-stone-500">
                    Preço digitado à mão: a promoção não está sendo aplicada nesta linha.
                  </p>
                )}

                <div className="mt-2 flex items-center justify-between">
                  {info ? (
                    <span className="text-xs font-bold text-red-700">
                      Faltam {info.missing} · disponível {info.available}
                      {p?.kind === "kit" ? " kit(s)" : ""}
                    </span>
                  ) : (
                    <span className="text-xs text-stone-400">Subtotal</span>
                  )}
                  <span className="text-sm font-bold text-tinta-900">{money(line)}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="flex items-center justify-between rounded-xl bg-nuvem-100 px-3 py-2.5">
        <span className="text-sm font-semibold text-stone-600">Subtotal dos produtos</span>
        <span className="text-base font-bold text-tinta-900">{money(subtotal)}</span>
      </div>
    </div>
  );
}
