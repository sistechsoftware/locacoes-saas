"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { brl, lerCarrinho, type ItemCarrinho } from "./carrinho";

/** Barra fixa com o resumo do pedido em andamento (some sem itens). */
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
    <div
      className="fixed inset-x-0 bottom-0 z-40 border-t px-4 py-3 shadow-lg"
      style={{ background: "var(--loja-card)", borderColor: "var(--loja-accent)" }}
    >
      <div className="mx-auto flex max-w-5xl items-center justify-between gap-3">
        <span className="text-sm">
          <b>{qtd} item(ns)</b>
          <span className="ml-2 font-bold">{brl(total)}</span>
        </span>
        <Link
          href={`/loja/${slug}/pedido`}
          className="px-4 py-2.5 text-sm font-bold text-white"
          style={{ background: "var(--loja-primary)", borderRadius: "var(--loja-radius)" }}
        >
          Revistar e enviar pedido
        </Link>
      </div>
    </div>
  );
}
