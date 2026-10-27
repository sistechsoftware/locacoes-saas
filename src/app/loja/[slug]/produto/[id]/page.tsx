import Link from "next/link";
import { notFound } from "next/navigation";
import { lojaPorSlug, produtoPublicado } from "@/lib/loja-publico";
import { brl } from "../../carrinho";
import ProdutoAcoes from "./ProdutoAcoes";
import DisponibilidadeProduto from "./DisponibilidadeProduto";

export const dynamic = "force-dynamic";

export default async function ProdutoPage({ params }: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await params;
  const r = await lojaPorSlug(slug, { requerPublicada: false });
  if (!r.ok) notFound();
  const { loja } = r;
  const produto = await produtoPublicado(loja, Number(id));
  if (!produto) notFound();

  const esconderPreco = loja.hide_prices === 1 || produto.preco_cents <= 0;

  return (
    <main className="mx-auto max-w-3xl px-4 pb-28 pt-6">
      <p className="mb-4 text-sm">
        <Link href={`/loja/${loja.slug}`} className="underline">
          ← Voltar ao catálogo
        </Link>
      </p>

      <div className="grid gap-4 sm:grid-cols-2">
        {produto.photo_loja || produto.photo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={produto.photo_loja || produto.photo!}
            alt={produto.name}
            className="w-full rounded-2xl object-cover"
            style={{ background: "var(--loja-card)" }}
          />
        ) : (
          <div
            className="flex h-56 items-center justify-center rounded-2xl text-sm opacity-50"
            style={{ background: "var(--loja-card)" }}
          >
            sem foto
          </div>
        )}

        <div className="space-y-4">
          <div>
            {produto.category && <p className="text-xs uppercase tracking-wide opacity-60">{produto.category}</p>}
            <h1 className="text-2xl font-bold">{produto.name}</h1>
            <p className="mt-1 text-xl font-bold">
              {esconderPreco ? "Preço sob consulta" : `${brl(produto.preco_cents)}${produto.pricing_mode === "diaria" ? " / diária" : ""}`}
            </p>
            {!esconderPreco && produto.pricing_mode === "diaria" && (
              <p className="text-xs opacity-60">Valor cobrado por diária; o total considera o período informado.</p>
            )}
          </div>

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

          <DisponibilidadeProduto slug={loja.slug} productId={produto.product_id} />
        </div>
      </div>

      {produto.description && (
        <section className="mt-6 rounded-2xl p-4" style={{ background: "var(--loja-card)" }}>
          <h2 className="mb-2 text-lg font-bold">Descrição</h2>
          <p className="whitespace-pre-line text-sm opacity-80">{produto.description}</p>
        </section>
      )}

      <section className="mt-4 rounded-2xl p-4 text-sm opacity-80" style={{ background: "var(--loja-card)" }}>
        <h2 className="mb-1 text-base font-bold">Como funciona</h2>
        <p>
          Adicione ao pedido, informe a data e os seus dados. A {loja.display_name || "locadora"} analisa a disponibilidade e
          responde com a proposta — valores podem ser ajustados na análise quando houver ajuste de frete ou condição especial.
        </p>
      </section>
    </main>
  );
}
