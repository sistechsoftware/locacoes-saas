import Link from "next/link";
import { notFound } from "next/navigation";
import { lojaPorSlug } from "@/lib/loja-publico";
import CheckoutForm, { type ConfigCheckout } from "../CheckoutForm";

export const dynamic = "force-dynamic";

export const metadata = { robots: { index: false, follow: false } };

export default async function CheckoutPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const r = await lojaPorSlug(slug, { requerPublicada: false });
  if (!r.ok) notFound();
  const { loja } = r;

  const config: ConfigCheckout = {
    offer_delivery: loja.offer_delivery === 1,
    offer_pickup: loja.offer_pickup === 1,
    require_terms: loja.require_terms === 1,
    terms_text: loja.terms_text,
    cancellation_text: loja.cancellation_text,
    privacy_text: loja.privacy_text,
    min_lead_days: loja.min_lead_days,
    hide_prices: loja.hide_prices === 1,
    aceitaOrcamento: true,
    freight_pending_ok: loja.freight_pending_ok === 1,
  };

  return (
    <main className="mx-auto max-w-3xl px-4 pb-16 pt-6">
      <p className="mb-4 text-sm">
        <Link href={`/loja/${loja.slug}`} className="underline">
          ← Voltar ao catálogo
        </Link>
      </p>
      <h1 className="mb-4 text-2xl font-bold">Montar pedido</h1>
      <CheckoutForm slug={loja.slug} config={config} />
    </main>
  );
}
