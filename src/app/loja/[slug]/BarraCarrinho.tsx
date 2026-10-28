"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { brl, lerCarrinho, type ItemCarrinho } from "./carrinho";

/**
 * Barra flutuante com o resumo do pedido em andamento (some sem itens).
 * Em vez de uma faixa colada na borda, é um cartão suspenso com margem —
 * a rolagem continua visível embaixo e a barra não "pesa" no rodapé.
 */
export default function BarraCarrinho({ slug }: { slug: string }) {
  const [itens, setItens] = useState<ItemCarrinho[]>([]);

  useEffect(() => {
    setItens(lerCarrinho(slug));
    const aoMudar = (e: Event) => {
      const detail = (e as CustomEvent).detail as { itens?: ItemCarrinho[] } | undefined;
      setItens(detail?.itens ?? lerCarrinho(slug));
    };
    window.addEventListener("loja:carrinho", aoMudar);
    window.addEventListener("storage", aoMudar);
    return () => {
      window.removeEventListener("loja:carrinho", aoMudar);
      window.removeEventListener("storage", aoMudar);
    };
  }, [slug]);

  if (!itens.length) return null;
  const qtd = itens.reduce((s, i) => s + i.qty, 0);
  const total = itens.reduce((s, i) => s + i.qty * i.unit_price_cents, 0);

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-40 px-4 pb-[calc(env(safe-area-inset-bottom)+1rem)]">
      <div
        className="pointer-events-auto mx-auto flex max-w-6xl items-center justify-between gap-3 rounded-2xl px-4 py-3 shadow-2xl"
        style={{
          background: "var(--loja-card)",
          border: "1px solid color-mix(in srgb, var(--loja-text) 12%, transparent)",
        }}
      >
        <div className="flex min-w-0 items-center gap-3">
          <span
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-bold text-white"
            style={{ background: "var(--loja-primary)" }}
            aria-hidden
          >
            {qtd}
          </span>
          <div className="min-w-0">
            <p className="truncate text-[0.7rem] font-semibold uppercase tracking-wider opacity-55">
              {qtd === 1 ? "1 item no pedido" : `${qtd} itens no pedido`}
            </p>
            <p className="text-base font-bold leading-tight tracking-tight">{brl(total)}</p>
          </div>
        </div>
        <Link
          href={`/loja/${slug}/pedido`}
          className="shrink-0 px-4 py-2.5 text-sm font-semibold text-white transition hover:brightness-110 active:scale-[0.98] sm:px-5"
          style={{ background: "var(--loja-primary)", borderRadius: "var(--loja-radius)" }}
        >
          Revistar e enviar pedido
        </Link>
      </div>
    </div>
  );
}
