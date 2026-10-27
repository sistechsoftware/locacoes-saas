"use client";
import Link from "next/link";
import { useMemo, useState } from "react";
import { adicionar, brl, lerCarrinho, type ItemCarrinho } from "./carrinho";

export type ItemCatalogoClient = {
  product_id: number;
  name: string;
  photo: string | null;
  photo_loja: string | null;
  category: string | null;
  preco_cents: number;
  pricing_mode: string | null;
  featured: number;
  max_qty: number | null;
  hide_prices: boolean;
};

/**
 * Catálogo com busca, filtro por categoria e adição ao carrinho. O preço
 * exibido vem do servidor; o carrinho guarda só product_id/qty e a submissão
 * recalcula tudo no backend.
 */
export default function CatalogoLoja({ slug, itens }: { slug: string; itens: ItemCatalogoClient[] }) {
  const [busca, setBusca] = useState("");
  const [categoria, setCategoria] = useState<string>("todas");
  const [ultimoAdd, setUltimoAdd] = useState<number | null>(null);

  const categorias = useMemo(() => [...new Set(itens.map((i) => i.category).filter(Boolean))] as string[], [itens]);

  const filtrados = useMemo(() => {
    const termo = busca.trim().toLowerCase();
    return itens.filter((i) => {
      if (categoria !== "todas" && i.category !== categoria) return false;
      if (!termo) return true;
      return i.name.toLowerCase().includes(termo) || (i.category ?? "").toLowerCase().includes(termo);
    });
  }, [itens, busca, categoria]);

  function adicionarAoCarrinho(i: ItemCatalogoClient) {
    const atual = lerCarrinho(slug);
    const item: ItemCarrinho = {
      product_id: i.product_id,
      name: i.name,
      qty: 1,
      unit_price_cents: i.preco_cents,
      photo: i.photo_loja || i.photo,
      max_qty: i.max_qty,
      pricing_mode: i.pricing_mode,
    };
    adicionar(slug, item);
    setUltimoAdd(i.product_id);
    setTimeout(() => setUltimoAdd((v) => (v === i.product_id ? null : v)), 1500);
    window.dispatchEvent(new CustomEvent("loja:carrinho", { detail: { slug, itens: lerCarrinho(slug) } }));
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
          placeholder="Buscar produto…"
          aria-label="Buscar produto"
          className="w-full rounded-xl border px-4 py-2.5 text-sm"
          style={{ borderColor: "var(--loja-secondary)", background: "var(--loja-card)", color: "var(--loja-text)" }}
        />
      </div>

      {categorias.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {[{ nome: "todas", label: "Todas" }, ...categorias.map((c) => ({ nome: c, label: c! }))].map((c) => (
            <button
              key={c.nome}
              type="button"
              onClick={() => setCategoria(c.nome)}
              className="rounded-full px-3 py-1.5 text-xs font-semibold"
              style={
                categoria === c.nome
                  ? { background: "var(--loja-primary)", color: "#fff" }
                  : { background: "var(--loja-card)", color: "var(--loja-text)", border: "1px solid var(--loja-accent)" }
              }
            >
              {c.label}
            </button>
          ))}
        </div>
      )}

      {filtrados.length === 0 && (
        <p className="rounded-xl border border-dashed p-8 text-center text-sm" style={{ borderColor: "var(--loja-accent)" }}>
          Nenhum produto encontrado para “{busca}”.
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {filtrados.map((i) => (
          <article
            key={i.product_id}
            className="flex flex-col overflow-hidden rounded-xl border"
            style={{ background: "var(--loja-card)", borderColor: "var(--loja-accent)" }}
          >
            <Link href={`/loja/${slug}/produto/${i.product_id}`} className="block">
              {i.photo_loja || i.photo ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={i.photo_loja || i.photo!} alt={i.name} className="h-40 w-full object-cover" loading="lazy" />
              ) : (
                <div className="flex h-40 w-full items-center justify-center text-xs opacity-50">sem foto</div>
              )}
            </Link>
            <div className="flex flex-1 flex-col gap-2 p-3">
              <div className="flex items-start justify-between gap-2">
                <Link href={`/loja/${slug}/produto/${i.product_id}`} className="font-semibold leading-tight">
                  {i.name}
                </Link>
                {i.featured === 1 && (
                  <span className="rounded-full px-2 py-0.5 text-[0.65rem] font-bold" style={{ background: "var(--loja-accent)", color: "#fff" }}>
                    destaque
                  </span>
                )}
              </div>
              {i.category && <p className="text-xs opacity-60">{i.category}</p>}
              <p className="text-sm font-bold">
                {i.hide_prices || i.preco_cents <= 0
                  ? "Sob consulta"
                  : `${brl(i.preco_cents)}${i.pricing_mode === "diaria" ? " / diária" : ""}`}
              </p>
              <button
                type="button"
                onClick={() => adicionarAoCarrinho(i)}
                className="mt-auto px-3 py-2 text-sm font-bold text-white"
                style={{ background: "var(--loja-primary)", borderRadius: "var(--loja-radius)" }}
              >
                {ultimoAdd === i.product_id ? "Adicionado ✓" : "Adicionar ao pedido"}
              </button>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
