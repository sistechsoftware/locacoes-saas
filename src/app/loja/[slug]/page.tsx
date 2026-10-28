import Link from "next/link";
import { notFound } from "next/navigation";
import { catalogoDaLoja, imagemPublica, lojaPorSlug } from "@/lib/loja-publico";
import CatalogoLoja, { type ItemCatalogoClient } from "./CatalogoLoja";
import BarraCarrinho from "./BarraCarrinho";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ slug: string }> };

function textoEmParagrafos(t: string) {
  return t.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
}

/* ------------------------------------------------------------------ */
/* Traços visuais compartilhados da loja (paleta própria da loja)      */
/* ------------------------------------------------------------------ */

/** Borda sutil derivada do texto da loja: vale em qualquer paleta. */
const borda = "1px solid color-mix(in srgb, var(--loja-text) 10%, transparent)";

const cartao: React.CSSProperties = {
  background: "var(--loja-card)",
  border: borda,
  boxShadow: "0 1px 2px rgba(16, 18, 22, 0.04)",
};

/** Botão principal: fundo na cor de ação da loja, texto branco (contraste AA validado no servidor). */
function btnPrimario(extra = ""): string {
  return `inline-flex items-center justify-center gap-2 px-5 py-2.5 text-sm font-semibold text-white transition hover:brightness-110 active:scale-[0.98] ${extra}`;
}

/** Botão secundário: cartão com borda suave. */
function btnSecundario(extra = ""): string {
  return `inline-flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-semibold transition hover:opacity-75 active:scale-[0.98] ${extra}`;
}

function TituloSecao({ eyebrow, titulo, extra }: { eyebrow: string; titulo: string; extra?: React.ReactNode }) {
  return (
    <div className="mb-5 flex items-end justify-between gap-4">
      <div>
        <p className="text-xs font-bold uppercase tracking-[0.16em]" style={{ color: "var(--loja-primary)" }}>
          {eyebrow}
        </p>
        <h2 className="mt-1 text-2xl font-bold tracking-tight">{titulo}</h2>
      </div>
      {extra}
    </div>
  );
}

export default async function LojaCatalogoPage({ params }: Params) {
  const { slug } = await params;
  const r = await lojaPorSlug(slug, { requerPublicada: false });
  if (!r.ok) notFound();
  const { loja, nomeEmpresa } = r;
  const itens = await catalogoDaLoja(loja);

  const nome = loja.display_name || nomeEmpresa;
  const banner = loja.show_banner === 1 ? imagemPublica(loja.slug, loja.banner_url) : null;
  const logo = imagemPublica(loja.slug, loja.logo_url);
  const whats = loja.whatsapp ? `https://wa.me/${loja.whatsapp.replace(/\D/g, "")}` : null;
  const contato = loja.show_contact === 1;

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

  const verSobre = loja.show_about === 1 && !!(loja.presentation || loja.about_text);
  const verEntrega =
    loja.show_delivery === 1 && !!(loja.delivery_text || loja.offer_delivery || loja.offer_pickup);
  const verFaq = loja.show_faq === 1 && faq.length > 0;

  return (
    <main className="pb-36">
      {/* ------------------------------------------------------------ */}
      {/* Hero: banner (ou gradiente da paleta) + identidade           */}
      {/* ------------------------------------------------------------ */}
      <header
        className="relative isolate overflow-hidden"
        style={{ background: "linear-gradient(135deg, var(--loja-primary) 0%, var(--loja-secondary) 100%)" }}
      >
        {banner && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={banner} alt="" className="absolute inset-0 h-full w-full object-cover" />
        )}
        <div
          className="absolute inset-0"
          style={{ background: "linear-gradient(180deg, rgba(8,10,14,0.15) 0%, rgba(8,10,14,0.62) 100%)" }}
        />
        <div className="relative mx-auto flex h-60 max-w-6xl flex-col justify-end px-4 pb-6 sm:h-72 sm:px-6 sm:pb-8">
          <div className="flex items-end gap-4">
            {logo && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={logo}
                alt=""
                className="h-16 w-16 shrink-0 rounded-2xl object-contain p-1.5 shadow-2xl sm:h-20 sm:w-20"
                style={{ background: "var(--loja-card)" }}
              />
            )}
            <div className="min-w-0 pb-1">
              <h1 className="truncate text-3xl font-bold tracking-tight text-white drop-shadow-sm sm:text-4xl">
                {nome}
              </h1>
              {loja.region && <p className="mt-1.5 text-sm font-medium text-white/85">{loja.region}</p>}
            </div>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        {/* Aviso de pausa da loja */}
        {loja.paused === 1 && (
          <div
            className="mt-5 flex items-start gap-3 rounded-2xl border-l-4 border-amber-500 bg-amber-50 px-4 py-3.5 text-sm font-medium text-amber-900"
            role="status"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="mt-0.5 h-4 w-4 shrink-0">
              <path d="M12 9v4m0 4h.01M10.3 3.9 2.5 17.4A1.9 1.9 0 0 0 4.2 20.3h15.6a1.9 1.9 0 0 0 1.7-2.9L13.7 3.9a1.9 1.9 0 0 0-3.4 0Z" strokeLinejoin="round" />
            </svg>
            <p>
              {loja.pause_message?.trim() ||
                "Esta loja não está recebendo novas solicitações no momento. Você ainda pode navegar pelo catálogo."}
            </p>
          </div>
        )}

        {/* Descrição + canais de contato */}
        <div className="flex flex-col gap-4 py-6 sm:flex-row sm:items-center sm:justify-between">
          <p className="max-w-2xl text-sm leading-relaxed opacity-75">
            {loja.description || `Catálogo de locação de ${nome}.`}
          </p>
          {contato && (whats || loja.phone || loja.instagram) && (
            <div className="flex flex-wrap gap-2 sm:justify-end">
              {whats && (
                <a
                  href={whats}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={btnPrimario()}
                  style={{ background: "var(--loja-primary)", borderRadius: "var(--loja-radius)" }}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4">
                    <path d="M21 11.5a8.4 8.4 0 0 1-12.3 7.4L3.5 20.5l1.7-5A8.4 8.4 0 1 1 21 11.5Z" strokeLinejoin="round" />
                  </svg>
                  Falar no WhatsApp
                </a>
              )}
              {loja.phone && (
                <a
                  href={`tel:${loja.phone.replace(/\s/g, "")}`}
                  className={btnSecundario()}
                  style={{ border: borda, background: "var(--loja-card)", borderRadius: "var(--loja-radius)" }}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4">
                    <path d="M6.5 3h3l1.5 4.5-2 1.3a13 13 0 0 0 5.7 5.7l1.3-2L20.5 14v3a2 2 0 0 1-2.2 2A16.5 16.5 0 0 1 4 6.2 2 2 0 0 1 6.5 3Z" strokeLinejoin="round" />
                  </svg>
                  Ligar
                </a>
              )}
              {loja.instagram && (
                <a
                  href={`https://instagram.com/${loja.instagram.replace(/^@/, "")}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={btnSecundario()}
                  style={{ border: borda, background: "var(--loja-card)", borderRadius: "var(--loja-radius)" }}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4">
                    <rect x="3" y="3" width="18" height="18" rx="5" />
                    <circle cx="12" cy="12" r="4" />
                    <circle cx="17.2" cy="6.8" r="1.1" fill="currentColor" stroke="none" />
                  </svg>
                  Instagram
                </a>
              )}
            </div>
          )}
        </div>

        {/* Aviso de destaque da loja */}
        {loja.notice_text && (
          <div
            className="mb-8 flex items-start gap-3 rounded-2xl px-4 py-3.5 text-sm font-medium"
            style={{
              background: "color-mix(in srgb, var(--loja-accent) 15%, var(--loja-card))",
              border: `1px solid color-mix(in srgb, var(--loja-accent) 55%, transparent)`,
            }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="mt-0.5 h-4 w-4 shrink-0" style={{ color: "var(--loja-primary)" }}>
              <path d="M12 3v2m0 14v2M5 12H3m18 0h-2M6.3 6.3 4.9 4.9m12.8 12.8 1.4 1.4M6.3 17.7l-1.4 1.4M17.7 6.3l1.4-1.4M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z" strokeLinejoin="round" />
            </svg>
            <p>{loja.notice_text}</p>
          </div>
        )}

        {/* ------------------------------------------------------------ */}
        {/* Catálogo                                                     */}
        {/* ------------------------------------------------------------ */}
        <section className="pt-2">
          <TituloSecao
            eyebrow="Catálogo"
            titulo="Nossos produtos"
            extra={
              itens.length > 0 ? (
                <p className="hidden text-sm opacity-60 sm:block">
                  {itens.length} {itens.length === 1 ? "item disponível" : "itens disponíveis"}
                </p>
              ) : undefined
            }
          />
          {itens.length === 0 ? (
            <div
              className="flex flex-col items-center gap-3 rounded-2xl border border-dashed px-6 py-12 text-center"
              style={{ borderColor: "color-mix(in srgb, var(--loja-text) 22%, transparent)" }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-8 w-8 opacity-40">
                <path d="M4 7.5 7 4.5h10l3 3V19a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 19V7.5Z" strokeLinejoin="round" />
                <path d="M4 12h4l1.5 2.5h5L16 12h4" strokeLinejoin="round" />
              </svg>
              <p className="max-w-md text-sm opacity-70">
                Nosso catálogo está sendo montado. Fale conosco pelo WhatsApp para consultar a disponibilidade.
              </p>
            </div>
          ) : (
            <CatalogoLoja slug={loja.slug} itens={itensCliente} />
          )}
        </section>

        {/* ------------------------------------------------------------ */}
        {/* Sobre / Entrega / FAQ em cards                               */}
        {/* ------------------------------------------------------------ */}
        {(verSobre || verEntrega) && (
          <div className="mt-12 grid gap-6 lg:grid-cols-2">
            {verSobre && (
              <section className="rounded-2xl p-5 sm:p-6" style={cartao}>
                <h2 className="mb-3 text-lg font-bold tracking-tight">Sobre nós</h2>
                <div className="space-y-2 text-sm leading-relaxed opacity-80">
                  {textoEmParagrafos(`${loja.presentation}\n\n${loja.about_text}`).map((p, i) => (
                    <p key={i}>{p}</p>
                  ))}
                </div>
              </section>
            )}

            {verEntrega && (
              <section className="rounded-2xl p-5 sm:p-6" style={cartao}>
                <h2 className="mb-3 text-lg font-bold tracking-tight">Entrega e retirada</h2>
                <ul className="space-y-2 text-sm leading-relaxed opacity-80">
                  {loja.offer_delivery === 1 && (
                    <li className="flex gap-2">
                      <span aria-hidden style={{ color: "var(--loja-primary)" }}>✓</span>
                      <span>Entrega no endereço informado (frete calculado pelo sistema ou confirmado pela locadora).</span>
                    </li>
                  )}
                  {loja.offer_pickup === 1 && (
                    <li className="flex gap-2">
                      <span aria-hidden style={{ color: "var(--loja-primary)" }}>✓</span>
                      <span>Retirada no local, sem custo de frete.</span>
                    </li>
                  )}
                  {loja.hours && (
                    <li className="flex gap-2">
                      <span aria-hidden style={{ color: "var(--loja-primary)" }}>✓</span>
                      <span>Horário de atendimento: {loja.hours}</span>
                    </li>
                  )}
                </ul>
                <div className="mt-3 space-y-2 text-sm leading-relaxed opacity-80">
                  {textoEmParagrafos(loja.delivery_text).map((p, i) => (
                    <p key={i}>{p}</p>
                  ))}
                </div>
              </section>
            )}
          </div>
        )}

        {verFaq && (
          <section className="mt-6 rounded-2xl p-5 sm:p-6" style={cartao}>
            <h2 className="mb-2 text-lg font-bold tracking-tight">Perguntas frequentes</h2>
            <dl>
              {faq.map((f, i) => (
                <details key={i} className="group border-t first:border-t-0" style={{ borderColor: borda }}>
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-4 py-3.5 text-sm font-semibold [&::-webkit-details-marker]:hidden">
                    <span>{f.q}</span>
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      className="h-4 w-4 shrink-0 opacity-50 transition group-open:rotate-180"
                    >
                      <path d="m6 9 6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </summary>
                  <p className="pb-4 text-sm leading-relaxed opacity-75">{f.a}</p>
                </details>
              ))}
            </dl>
          </section>
        )}

        {/* ------------------------------------------------------------ */}
        {/* Rodapé                                                       */}
        {/* ------------------------------------------------------------ */}
        <footer className="mt-12 border-t pt-6 text-center text-xs leading-relaxed" style={{ borderColor: borda }}>
          <p className="text-sm font-bold tracking-tight">{nome}</p>
          {(loja.address || loja.city) && (
            <p className="mt-1 opacity-70">
              {[loja.address, loja.city].filter(Boolean).join(" · ")}
            </p>
          )}
          {loja.extra_info && <p className="mt-1 opacity-70">{loja.extra_info}</p>}
          <p className="mx-auto mt-3 max-w-2xl opacity-60">
            Suas informações são usadas apenas para responder a esta solicitação, conforme a LGPD. Pedidos e comprovantes não
            são públicos: o acompanhamento acontece por link seguro.
          </p>
          <Link
            href={`/loja/${loja.slug}/pedido`}
            className="mt-4 inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold transition hover:opacity-75"
            style={{ border: borda, borderRadius: "var(--loja-radius)" }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-3.5 w-3.5">
              <path d="M4 6.5h2l2.2 8.4a1.5 1.5 0 0 0 1.5 1.1h7.3a1.5 1.5 0 0 0 1.5-1.1L20.5 9H7" strokeLinecap="round" strokeLinejoin="round" />
              <circle cx="10" cy="20" r="1.2" fill="currentColor" stroke="none" />
              <circle cx="17" cy="20" r="1.2" fill="currentColor" stroke="none" />
            </svg>
            Ver meu pedido em andamento
          </Link>
        </footer>
      </div>

      <BarraCarrinho slug={loja.slug} />
    </main>
  );
}
