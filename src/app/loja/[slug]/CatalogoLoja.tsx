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

const borda = "1px solid color-mix(in srgb, var(--loja-text) 10%, transparent)";

/* Sombra suave no repouso, profundidade no hover — utilitários arbitrários do
   Tailwind (vence o inline), sem handler de mouse. */
const SOMBRA = "shadow-[0_1px_2px_rgba(16,18,22,0.04)] hover:shadow-[0_14px_30px_-18px_rgba(16,18,22,0.45)]";

/** Placeholder de foto: superfície tingida com a paleta, nunca um quadrado vazio. */
function SemFoto() {
  return (
    <div
      className="flex h-full w-full items-center justify-center"
      style={{
        background:
          "linear-gradient(135deg, color-mix(in srgb, var(--loja-primary) 10%, var(--loja-card)) 0%, color-mix(in srgb, var(--loja-secondary) 14%, var(--loja-card)) 100%)",
      }}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-9 w-9 opacity-30">
        <rect x="3" y="5" width="18" height="14" rx="2.5" />
        <circle cx="8.5" cy="10" r="1.6" />
        <path d="m4 17 4.5-4.2 3.2 2.8 3-2.6L20 16.5" strokeLinejoin="round" />
      </svg>
    </div>
  );
}

/**
 * Catálogo com busca, filtro por categoria e adição ao carrinho. O preço
 * exibido vem do servidor; o carrinho guarda só product_id/qty e a submissão
 * recalcula tudo no backend.
 */
export default function CatalogoLoja({ slug, itens }: { slug: string; itens: ItemCatalogoClient[] }) {
  const [busca, setBusca] = useState("");
  const [categoria, setCategoria] = useState<string>("todas");
  const [ultimoAdd, setUltimoAdd] = useState<number | null>(null);
  /** Quantidade escolhida em cada card antes de adicionar (product_id → qty). */
  const [quantidades, setQuantidades] = useState<Record<number, number>>({});

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
    const qtd = quantidadeDe(i);
    const item: ItemCarrinho = {
      product_id: i.product_id,
      name: i.name,
      qty: qtd,
      unit_price_cents: i.preco_cents,
      photo: i.photo_loja || i.photo,
      max_qty: i.max_qty,
      pricing_mode: i.pricing_mode,
    };
    adicionar(slug, item);
    setUltimoAdd(i.product_id);
    setQuantidades((q) => ({ ...q, [i.product_id]: 1 })); // volta a 1 após adicionar
    setTimeout(() => setUltimoAdd((v) => (v === i.product_id ? null : v)), 1500);
    window.dispatchEvent(new CustomEvent("loja:carrinho", { detail: { slug, itens: lerCarrinho(slug) } }));
  }

  /** Quantidade atual do card (clamp entre 1 e max_qty quando houver limite). */
  function quantidadeDe(i: ItemCatalogoClient): number {
    const bruto = quantidades[i.product_id] ?? 1;
    const limite = i.max_qty ?? 999;
    return Math.min(Math.max(1, Math.floor(bruto || 1)), limite);
  }

  function mudarQuantidade(i: ItemCatalogoClient, delta: number) {
    const limite = i.max_qty ?? 999;
    setQuantidades((q) => {
      const atual = Math.min(Math.max(1, q[i.product_id] ?? 1), limite);
      return { ...q, [i.product_id]: Math.min(limite, Math.max(1, atual + delta)) };
    });
  }

  return (
    <div className="space-y-5">
      {/* Busca + contagem */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 opacity-45"
          >
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.6-3.6" strokeLinecap="round" />
          </svg>
          <input
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            placeholder="Buscar produto…"
            aria-label="Buscar produto"
            className="w-full rounded-xl border py-2.5 pl-11 pr-4 text-sm outline-none transition focus:ring-2 focus:ring-[color-mix(in_srgb,var(--loja-primary)_45%,transparent)]"
            style={{
              borderColor: "color-mix(in srgb, var(--loja-text) 14%, transparent)",
              background: "var(--loja-card)",
              color: "var(--loja-text)",
            }}
          />
        </div>
        <p className="text-sm opacity-55 sm:pl-1">
          {filtrados.length} {filtrados.length === 1 ? "produto" : "produtos"}
        </p>
      </div>

      {/* Categorias */}
      {categorias.length > 0 && (
        <div className="scroll-x -mx-1 flex gap-2 px-1 pb-1">
          {[{ nome: "todas", label: "Todas" }, ...categorias.map((c) => ({ nome: c, label: c! }))].map((c) => {
            const ativo = categoria === c.nome;
            return (
              <button
                key={c.nome}
                type="button"
                onClick={() => setCategoria(c.nome)}
                className="shrink-0 rounded-full px-4 py-1.5 text-xs font-semibold transition active:scale-[0.98]"
                style={
                  ativo
                    ? { background: "var(--loja-primary)", color: "#fff" }
                    : {
                        background: "var(--loja-card)",
                        color: "var(--loja-text)",
                        border: "1px solid color-mix(in srgb, var(--loja-text) 12%, transparent)",
                        opacity: 0.85,
                      }
                }
              >
                {c.label}
              </button>
            );
          })}
        </div>
      )}

      {/* Sem resultados */}
      {filtrados.length === 0 && (
        <div
          className="flex flex-col items-center gap-2 rounded-2xl border border-dashed px-6 py-10 text-center"
          style={{ borderColor: "color-mix(in srgb, var(--loja-text) 20%, transparent)" }}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-7 w-7 opacity-35">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.6-3.6M8.5 11h5" strokeLinecap="round" />
          </svg>
          <p className="text-sm opacity-70">
            {busca.trim() ? `Nenhum produto encontrado para “${busca}”.` : "Nenhum produto nesta categoria."}
          </p>
        </div>
      )}

      {/* Grid de produtos */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {filtrados.map((i) => (
          <article
            key={i.product_id}
            className={`group flex flex-col overflow-hidden rounded-2xl transition duration-200 hover:-translate-y-0.5 ${SOMBRA}`}
            style={{ background: "var(--loja-card)", border: borda }}
          >
            <Link href={`/loja/${slug}/produto/${i.product_id}`} className="relative block aspect-[4/3] overflow-hidden">
              {i.photo_loja || i.photo ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={i.photo_loja || i.photo!}
                  alt={i.name}
                  loading="lazy"
                  className="h-full w-full object-cover transition duration-300 group-hover:scale-[1.03]"
                />
              ) : (
                <SemFoto />
              )}
              {i.featured === 1 && (
                <span
                  className="absolute left-3 top-3 rounded-full px-2.5 py-1 text-[0.65rem] font-bold uppercase tracking-wider text-white shadow-sm"
                  style={{ background: "var(--loja-accent)" }}
                >
                  destaque
                </span>
              )}
            </Link>

            <div className="flex flex-1 flex-col p-4">
              {i.category && (
                <p className="mb-1 text-[0.7rem] font-semibold uppercase tracking-[0.12em] opacity-50">{i.category}</p>
              )}
              <Link
                href={`/loja/${slug}/produto/${i.product_id}`}
                className="text-[0.95rem] font-semibold leading-snug transition group-hover:opacity-75"
              >
                {i.name}
              </Link>
              <p className="mt-1.5 text-lg font-bold tracking-tight" style={{ color: "var(--loja-primary)" }}>
                {i.hide_prices || i.preco_cents <= 0
                  ? "Sob consulta"
                  : `${brl(i.preco_cents)}${i.pricing_mode === "diaria" ? " / diária" : ""}`}
              </p>
              {/* Quantidade: escolher antes de adicionar */}
              <div className="mt-3 flex items-center justify-between gap-3">
                <div
                  className="flex items-center rounded-xl"
                  style={{
                    border: "1px solid color-mix(in srgb, var(--loja-text) 14%, transparent)",
                    background: "var(--loja-bg)",
                  }}
                >
                  <button
                    type="button"
                    onClick={() => mudarQuantidade(i, -1)}
                    disabled={quantidadeDe(i) <= 1}
                    aria-label={`Diminuir quantidade de ${i.name}`}
                    className="px-3 py-1.5 text-base font-bold transition hover:opacity-60 disabled:opacity-30"
                  >
                    −
                  </button>
                  <span className="w-7 text-center text-sm font-semibold tabular-nums">{quantidadeDe(i)}</span>
                  <button
                    type="button"
                    onClick={() => mudarQuantidade(i, 1)}
                    disabled={i.max_qty != null && quantidadeDe(i) >= i.max_qty}
                    aria-label={`Aumentar quantidade de ${i.name}`}
                    className="px-3 py-1.5 text-base font-bold transition hover:opacity-60 disabled:opacity-30"
                  >
                    +
                  </button>
                </div>
                {i.max_qty != null && i.max_qty > 1 && (
                  <span className="text-[0.65rem] leading-tight opacity-50">máx. {i.max_qty}</span>
                )}
              </div>

              <button
                type="button"
                onClick={() => adicionarAoCarrinho(i)}
                className="mt-3 w-full px-4 py-2.5 text-sm font-semibold text-white transition hover:brightness-110 active:scale-[0.98]"
                style={{
                  background: ultimoAdd === i.product_id ? "var(--loja-secondary)" : "var(--loja-primary)",
                  borderRadius: "var(--loja-radius)",
                }}
              >
                {ultimoAdd === i.product_id
                  ? "Adicionado ✓"
                  : `Adicionar${quantidadeDe(i) > 1 ? ` ${quantidadeDe(i)}` : ""} ao pedido`}
              </button>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
