import Link from "next/link";
import { notFound } from "next/navigation";
import { catalogoDaLoja, lojaPorSlug } from "@/lib/loja-publico";
import CatalogoLoja, { type ItemCatalogoClient } from "./CatalogoLoja";
import BarraCarrinho from "./BarraCarrinho";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ slug: string }> };

function textoEmParagrafos(t: string) {
  return t.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
}

export default async function LojaCatalogoPage({ params }: Params) {
  const { slug } = await params;
  const r = await lojaPorSlug(slug, { requerPublicada: false });
  if (!r.ok) notFound();
  const { loja, nomeEmpresa } = r;
  const itens = await catalogoDaLoja(loja);

  const itensCliente: ItemCatalogoClient[] = itens.map((i) => ({
    product_id: i.product_id,
    name: i.name,
    photo: i.photo,
    photo_loja: i.photo_loja,
    category: i.category,
    preco_cents: i.preco_cents,
    pricing_mode: i.pricing_mode,
    featured: i.featured,
    max_qty: i.max_qty,
    hide_prices: loja.hide_prices === 1,
  }));

  const faq: { q: string; a: string }[] = (() => {
    try {
      const v = JSON.parse(loja.faq_json || "[]");
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  })();

  const whats = loja.whatsapp ? `https://wa.me/${loja.whatsapp.replace(/\D/g, "")}` : null;

  return (
    <main className="mx-auto max-w-5xl px-4 pb-28 pt-6">
      {loja.paused === 1 && (
        <p className="mb-4 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {loja.pause_message?.trim() || "Esta loja não está recebendo novas solicitações no momento. Você ainda pode navegar pelo catálogo."}
        </p>
      )}

      {/* Identidade */}
      <header className="mb-6 space-y-3">
        {loja.show_banner === 1 && loja.banner_url && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={loja.banner_url} alt="" className="h-44 w-full rounded-2xl object-cover sm:h-60" />
        )}
        <div className="flex items-center gap-3">
          {loja.logo_url && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={loja.logo_url} alt={loja.display_name} className="h-14 w-14 rounded-xl object-contain" style={{ background: "var(--loja-card)" }} />
          )}
          <div>
            <h1 className="text-2xl font-bold sm:text-3xl">{loja.display_name || nomeEmpresa}</h1>
            {loja.region && <p className="text-sm opacity-70">{loja.region}</p>}
          </div>
        </div>
        {loja.description && <p className="text-sm opacity-80">{loja.description}</p>}
        {loja.notice_text && (
          <p className="rounded-xl px-3 py-2 text-sm font-semibold" style={{ background: "var(--loja-accent)", color: "#fff" }}>
            {loja.notice_text}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          {loja.show_contact === 1 && whats && (
            <a
              href={whats}
              target="_blank"
              rel="noopener noreferrer"
              className="px-4 py-2 text-sm font-bold text-white"
              style={{ background: "var(--loja-primary)", borderRadius: "var(--loja-radius)" }}
            >
              Falar no WhatsApp
            </a>
          )}
          {loja.show_contact === 1 && loja.phone && (
            <a
              href={`tel:${loja.phone.replace(/\s/g, "")}`}
              className="px-4 py-2 text-sm font-semibold"
              style={{ border: "1px solid var(--loja-secondary)", borderRadius: "var(--loja-radius)" }}
            >
              Ligar: {loja.phone}
            </a>
          )}
          {loja.show_contact === 1 && loja.instagram && (
            <a
              href={`https://instagram.com/${loja.instagram.replace(/^@/, "")}`}
              target="_blank"
              rel="noopener noreferrer"
              className="px-4 py-2 text-sm font-semibold"
              style={{ border: "1px solid var(--loja-secondary)", borderRadius: "var(--loja-radius)" }}
            >
              Instagram
            </a>
          )}
        </div>
      </header>

      <section className="mb-8">
        <h2 className="mb-3 text-lg font-bold">Nossos produtos</h2>
        {itens.length === 0 ? (
          <p className="rounded-xl border border-dashed p-8 text-center text-sm opacity-70">
            Nosso catálogo está sendo montado. Fale conosco pelo WhatsApp para consultar a disponibilidade.
          </p>
        ) : (
          <CatalogoLoja slug={loja.slug} itens={itensCliente} />
        )}
      </section>

      {loja.show_about === 1 && (loja.presentation || loja.about_text) && (
        <section className="mb-8 rounded-2xl p-4" style={{ background: "var(--loja-card)" }}>
          <h2 className="mb-2 text-lg font-bold">Sobre nós</h2>
          {textoEmParagrafos(`${loja.presentation}\n\n${loja.about_text}`).map((p, i) => (
            <p key={i} className="mb-2 text-sm opacity-80">
              {p}
            </p>
          ))}
        </section>
      )}

      {loja.show_delivery === 1 && (loja.delivery_text || loja.offer_delivery || loja.offer_pickup) && (
        <section className="mb-8 rounded-2xl p-4" style={{ background: "var(--loja-card)" }}>
          <h2 className="mb-2 text-lg font-bold">Entrega e retirada</h2>
          <ul className="list-disc space-y-1 pl-5 text-sm opacity-80">
            {loja.offer_delivery === 1 && <li>Entrega no endereço informado (frete calculado pelo sistema, ou confirmado pela locadora).</li>}
            {loja.offer_pickup === 1 && <li>Retirada no local, sem custo de frete.</li>}
            {loja.hours && <li>Horário de atendimento: {loja.hours}</li>}
          </ul>
          {textoEmParagrafos(loja.delivery_text).map((p, i) => (
            <p key={i} className="mt-2 text-sm opacity-80">
              {p}
            </p>
          ))}
        </section>
      )}

      {loja.show_faq === 1 && faq.length > 0 && (
        <section className="mb-8 rounded-2xl p-4" style={{ background: "var(--loja-card)" }}>
          <h2 className="mb-2 text-lg font-bold">Perguntas frequentes</h2>
          <dl className="space-y-3">
            {faq.map((f, i) => (
              <div key={i}>
                <dt className="text-sm font-semibold">{f.q}</dt>
                <dd className="text-sm opacity-80">{f.a}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      <footer className="border-t pt-4 text-xs opacity-70" style={{ borderColor: "var(--loja-accent)" }}>
        <p>
          {loja.display_name || nomeEmpresa}
          {loja.address ? ` · ${loja.address}` : ""}
          {loja.city ? ` · ${loja.city}` : ""}
        </p>
        {loja.extra_info && <p className="mt-1">{loja.extra_info}</p>}
        <p className="mt-1">
          Suas informações são usadas apenas para responder a esta solicitação, conforme a LGPD. Pedidos e comprovantes não são
          públicos: o acompanhamento acontece por link seguro.
        </p>
        <p className="mt-1">
          <Link href={`/loja/${loja.slug}/pedido`} className="underline">
        Ver meu pedido em andamento
          </Link>
        </p>
      </footer>

      <BarraCarrinho slug={loja.slug} />
    </main>
  );
}
