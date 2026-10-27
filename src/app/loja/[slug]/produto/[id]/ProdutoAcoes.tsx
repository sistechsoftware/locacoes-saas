"use client";
import { useState } from "react";
import { adicionar, brl } from "../../carrinho";

/** Seletor de quantidade + adicionar ao pedido (página de detalhe). */
export default function ProdutoAcoes({
  slug,
  product,
}: {
  slug: string;
  product: {
    product_id: number;
    name: string;
    photo: string | null;
    preco_cents: number;
    pricing_mode: string | null;
    max_qty: number | null;
    hide_prices: boolean;
  };
}) {
  const [qty, setQty] = useState(1);
  const [adicionado, setAdicionado] = useState(false);
  const limite = product.max_qty ?? 999;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <div className="flex items-center rounded-xl border" style={{ borderColor: "var(--loja-secondary)" }}>
          <button type="button" className="px-3 py-2 text-lg font-bold" onClick={() => setQty((q) => Math.max(1, q - 1))} aria-label="Diminuir">
            −
          </button>
          <span className="w-8 text-center font-semibold">{qty}</span>
          <button
            type="button"
            className="px-3 py-2 text-lg font-bold"
            onClick={() => setQty((q) => Math.min(limite, q + 1))}
            aria-label="Aumentar"
          >
            +
          </button>
        </div>
        {product.max_qty && <span className="text-xs opacity-60">máx. {product.max_qty} por pedido</span>}
      </div>
      <button
        type="button"
        className="w-full px-4 py-3 font-bold text-white"
        style={{ background: "var(--loja-primary)", borderRadius: "var(--loja-radius)" }}
        onClick={() => {
          adicionar(slug, {
            product_id: product.product_id,
            name: product.name,
            qty,
            unit_price_cents: product.preco_cents,
            photo: product.photo,
            max_qty: product.max_qty,
            pricing_mode: product.pricing_mode,
          });
          setAdicionado(true);
          window.dispatchEvent(new CustomEvent("loja:carrinho", { detail: { slug } }));
          setTimeout(() => setAdicionado(false), 2000);
        }}
      >
        {adicionado ? "Adicionado ✓" : `Adicionar ao pedido${!product.hide_prices && product.preco_cents > 0 ? ` · ${brl(product.preco_cents * qty)}` : ""}`}
      </button>
    </div>
  );
}
