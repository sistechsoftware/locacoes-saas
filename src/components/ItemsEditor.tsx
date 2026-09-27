"use client";
import { useEffect, useMemo, useState } from "react";
import { money, parseMoney } from "@/lib/format";
import { precoUnitario, rotuloFaixa, type Promocao } from "@/lib/promocoes";
import { Icon } from "./Icons";

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
};

export type ItemRow = {
  product_id: number;
  qty: number;
  unit_price_cents: number;
  discount_cents: number;
  /**
   * O operador digitou este preco a mao?
   *
   * Enquanto for automatico, mudar a quantidade recalcula pela promocao. Depois
   * que alguem digita um valor, o sistema para de mexer: sobrescrever o que a
   * pessoa acabou de escrever seria pior que nao ter promocao nenhuma.
   */
  preco_manual?: boolean;
};

export type StockInfo = Record<number, { available: number; requested: number; missing: number }>;

/** Editor de itens compartilhado por reservas e orcamentos. */
export default function ItemsEditor({
  products,
  items,
  onChange,
  stock,
  dataReferencia,
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
}) {
  const [picker, setPicker] = useState("");
  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const dia = dataReferencia || new Date().toISOString().slice(0, 10);

  /** Preco que a regra manda cobrar por esta linha, com a faixa que o justifica. */
  const calcular = (productId: number, qty: number) => {
    const p = byId.get(productId);
    return precoUnitario(p?.rent_price_cents ?? 0, p?.promocao, qty, dia);
  };

  // a promocao muda com a quantidade, entao o preco automatico e recalculado
  // sempre que a linha muda; a linha com preco digitado a mao fica intacta
  useEffect(() => {
    let mudou = false;
    const ajustados = items.map((i) => {
      if (i.preco_manual) return i;
      const alvo = calcular(i.product_id, i.qty).unit_price_cents;
      if (alvo === i.unit_price_cents) return i;
      mudou = true;
      return { ...i, unit_price_cents: alvo };
    });
    if (mudou) onChange(ajustados);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, dia]);

  const add = (productId: number) => {
    if (!productId) return;
    const p = byId.get(productId);
    if (!p) return;
    const existing = items.find((i) => i.product_id === productId);
    if (existing) {
      onChange(items.map((i) => (i.product_id === productId ? { ...i, qty: i.qty + 1 } : i)));
    } else {
      onChange([
        ...items,
        {
          product_id: productId,
          qty: 1,
          unit_price_cents: calcular(productId, 1).unit_price_cents,
          discount_cents: 0,
        },
      ]);
    }
    setPicker("");
  };

  const patch = (index: number, changes: Partial<ItemRow>) =>
    onChange(items.map((i, idx) => (idx === index ? { ...i, ...changes } : i)));

  const remove = (index: number) => onChange(items.filter((_, idx) => idx !== index));

  const subtotal = items.reduce((s, i) => s + Math.max(0, i.qty * i.unit_price_cents - i.discount_cents), 0);

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
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>

      {items.length === 0 ? (
        <p className="rounded-xl border border-dashed border-nuvem-300 bg-nuvem-50 px-3 py-6 text-center text-sm text-stone-500">
          Nenhum item adicionado ainda.
        </p>
      ) : (
        <div className="space-y-2">
          {items.map((item, index) => {
            const p = byId.get(item.product_id);
            const info = stock?.[item.product_id];
            const line = Math.max(0, item.qty * item.unit_price_cents - item.discount_cents);
            const promo = calcular(item.product_id, item.qty);
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
                    <span className="mb-0.5 block text-[0.68rem] font-semibold uppercase text-stone-500">Valor un.</span>
                    <input
                      key={`${item.product_id}-${item.unit_price_cents}`}
                      defaultValue={(item.unit_price_cents / 100).toFixed(2)}
                      onBlur={(e) => {
                        const digitado = parseMoney(e.target.value);
                        if (digitado === item.unit_price_cents) return;
                        // a partir daqui o preco e escolha da pessoa, nao da regra
                        patch(index, { unit_price_cents: digitado, preco_manual: true });
                      }}
                      inputMode="decimal"
                      className="w-full rounded-lg border border-nuvem-300 px-2 py-2 text-sm outline-none"
                    />
                  </label>

                  <label className="block">
                    <span className="mb-0.5 block text-[0.68rem] font-semibold uppercase text-stone-500">Desconto</span>
                    <input
                      defaultValue={(item.discount_cents / 100).toFixed(2)}
                      onBlur={(e) => patch(index, { discount_cents: parseMoney(e.target.value) })}
                      inputMode="decimal"
                      className="w-full rounded-lg border border-nuvem-300 px-2 py-2 text-sm outline-none"
                    />
                  </label>
                </div>

                {promo.promocional && !item.preco_manual && (
                  <p className="mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 rounded-lg bg-emerald-50 px-2 py-1.5 text-xs text-emerald-800">
                    <span className="font-bold">Promoção aplicada</span>
                    <span>
                      {rotuloFaixa(promo.faixa!)}: {money(promo.unit_price_cents)} cada
                    </span>
                    {p && p.rent_price_cents > promo.unit_price_cents && (
                      <span className="text-emerald-700">
                        (normal <s>{money(p.rent_price_cents)}</s>, economia de{" "}
                        {money((p.rent_price_cents - promo.unit_price_cents) * item.qty)})
                      </span>
                    )}
                  </p>
                )}
                {item.preco_manual && p?.promocao && (
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
