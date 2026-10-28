import Link from "next/link";
import { notFound } from "next/navigation";
import { lojaPorSlug, produtoPublicado } from "@/lib/loja-publico";
import ProdutoAcoes from "./ProdutoAcoes";
import DisponibilidadeProduto from "./DisponibilidadeProduto";

export const dynamic = "force-dynamic";

/**
 * Formata centavos em R$ 1.234,56. Mesmo formato de carrinho.ts, mas AQUI no
 * servidor: o `brl` do carrinho e client-only ("use client") e chamá-lo num
 * Server Component derruba a página ("cannot call a client function from the
 * server"). O preço exibido vem do servidor e não muda no cliente.
 */
const brlServer = (cents: number) =>
  `R$ ${(Number(cents || 0) / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const borda = "1px solid color-mix(in srgb, var(--loja-text) 10%, transparent)";

const cartao = {
  background: "var(--loja-card)",
  border: borda,
  boxShadow: "0 1px 2px rgba(16, 18, 22, 0.04)",
} as const;

export default async function ProdutoPage({ params }: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await params;
  const r = await lojaPorSlug(slug, { requerPublicada: false });
  if (!r.ok) notFound();
  const { loja } = r;
  const produto = await produtoPublicado(loja, Number(id));
  if (!produto) notFound();

  const esconderPreco = loja.hide_prices === 1 || produto.preco_cents <= 0;

  return (
    <main className="mx-auto max-w-6xl px-4 pb-32 pt-6 sm:px-6">
      {/* Trilha de navegação */}
      <nav className="mb-6">
        <Link
          href={`/loja/${loja.slug}`}
          className="inline-flex items-center gap-1.5 text-sm font-semibold transition hover:opacity-70"
          style={{ color: "var(--loja-primary)" }}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4">
            <path d="m14 6-6 6 6 6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Voltar ao catálogo
        </Link>
      </nav>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Foto */}
        <div
          className="overflow-hidden rounded-3xl"
          style={{ background: "var(--loja-card)", border: borda }}
        >
          {produto.photo_loja || produto.photo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={produto.photo_loja || produto.photo!}
              alt={produto.name}
              className="aspect-[4/3] w-full object-cover lg:aspect-square"
            />
          ) : (
            <div
              className="flex aspect-[4/3] w-full items-center justify-center lg:aspect-square"
              style={{
                background:
                  "linear-gradient(135deg, color-mix(in srgb, var(--loja-primary) 10%, var(--loja-card)) 0%, color-mix(in srgb, var(--loja-secondary) 14%, var(--loja-card)) 100%)",
              }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-12 w-12 opacity-30">
                <rect x="3" y="5" width="18" height="14" rx="2.5" />
                <circle cx="8.5" cy="10" r="1.6" />
                <path d="m4 17 4.5-4.2 3.2 2.8 3-2.6L20 16.5" strokeLinejoin="round" />
              </svg>
            </div>
          )}
        </div>

        {/* Identificação + ações */}
        <div className="flex flex-col gap-4">
          <div>
            {produto.category && (
              <p className="text-xs font-bold uppercase tracking-[0.16em] opacity-55">{produto.category}</p>
            )}
            <h1 className="mt-1.5 text-3xl font-bold tracking-tight">{produto.name}</h1>
            <p
              className="mt-3 text-3xl font-bold tracking-tight"
              style={{ color: esconderPreco ? undefined : "var(--loja-primary)" }}
            >
              {esconderPreco
                ? "Preço sob consulta"
                : `${brlServer(produto.preco_cents)}${produto.pricing_mode === "diaria" ? " / diária" : ""}`}
            </p>
            {!esconderPreco && produto.pricing_mode === "diaria" && (
              <p className="mt-1 text-xs opacity-60">
                Valor cobrado por diária; o total considera o período informado.
              </p>
            )}
          </div>

          <div className="rounded-2xl p-5" style={cartao}>
            <ProdutoAcoes
              slug={loja.slug}
              product={{
                product_id: produto.product_id,
                name: produto.name,
                photo: produto.photo_loja || produto.photo,
                preco_cents: produto.preco_cents,
                pricing_mode: produto.pricing_mode,
                max_qty: produto.max_qty,
                hide_prices: loja.hide_prices === 1,
              }}
            />
          </div>

          <DisponibilidadeProduto slug={loja.slug} productId={produto.product_id} />
        </div>
      </div>

      {/* Descrição + como funciona */}
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        {produto.description && (
          <section className="rounded-2xl p-5 sm:p-6" style={cartao}>
            <h2 className="mb-2 text-lg font-bold tracking-tight">Descrição</h2>
            <p className="whitespace-pre-line text-sm leading-relaxed opacity-80">{produto.description}</p>
          </section>
        )}

        <section className="rounded-2xl p-5 sm:p-6" style={cartao}>
          <h2 className="mb-2 text-lg font-bold tracking-tight">Como funciona</h2>
          <p className="text-sm leading-relaxed opacity-80">
            Adicione ao pedido, informe a data e os seus dados. A {loja.display_name || "locadora"} analisa a
            disponibilidade e responde com a proposta — valores podem ser ajustados na análise quando houver ajuste de
            frete ou condição especial.
          </p>
        </section>
      </div>
    </main>
  );
}
