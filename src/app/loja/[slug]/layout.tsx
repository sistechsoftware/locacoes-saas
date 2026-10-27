import { notFound } from "next/navigation";
import { lojaPorSlug } from "@/lib/loja-publico";
import { coresDaLoja, cssDaLoja } from "@/lib/loja";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ slug: string }> };

/**
 * Layout público da loja: resolve o slug (loja publicada + empresa ativa +
 * recurso liberado), injeta a paleta da loja em variáveis próprias (--loja-*)
 * e emite o SEO/metadados de compartilhamento. Loja fora do ar = 404 para o
 * público; o acompanhamento de pedidos existentes tem rota própria com
 * `requerPublicada: false`.
 */
export async function generateMetadata({ params }: Params) {
  const { slug } = await params;
  const r = await lojaPorSlug(slug, { requerPublicada: false });
  if (!r.ok) return {};
  const l = r.loja;
  const publicada = l.status === "publicada";
  const titulo = l.seo_title?.trim() || l.display_name || r.nomeEmpresa;
  const descricao = l.seo_description?.trim() || l.description?.trim() || `Catálogo de locação de ${l.display_name || r.nomeEmpresa}.`;
  const imagem = l.seo_image_url || l.banner_url || l.logo_url || undefined;
  const url = `/loja/${l.slug}`;
  return {
    title: titulo,
    description: descricao,
    alternates: { canonical: url },
    robots: publicada ? { index: true, follow: true } : { index: false, follow: false },
    openGraph: {
      title: titulo,
      description: descricao,
      url,
      siteName: l.display_name || r.nomeEmpresa,
      type: "website",
      locale: "pt_BR",
      ...(imagem ? { images: [{ url: imagem }] } : {}),
    },
    twitter: { card: "summary_large_image", title: titulo, description: descricao, ...(imagem ? { images: [imagem] } : {}) },
  };
}

export default async function LojaLayout({ children, params }: Params & { children: React.ReactNode }) {
  const { slug } = await params;
  const r = await lojaPorSlug(slug, { requerPublicada: false });
  if (!r.ok) notFound();
  const { loja } = r;

  /*
   * Loja não publicada é 404 para o mundo. A PRÓPRIA empresa (owner/admin da
   * mesma empresa) acessa para fazer a prévia antes de publicar — o acesso é
   * conferido no backend pela sessão, nunca por parâmetro de URL.
   */
  const publicada = loja.status === "publicada";
  if (!publicada) {
    const { currentUser } = await import("@/lib/auth");
    const { ehAdmin } = await import("@/lib/roles");
    const user = await currentUser();
    if (!user || user.company_id !== loja.company_id || !ehAdmin(user.role)) notFound();
  }
  const css = cssDaLoja(coresDaLoja(loja), loja.button_style === "quadrado" ? "quadrado" : "arredondado");

  return (
    <>
      <style data-loja-tema={loja.slug} dangerouslySetInnerHTML={{ __html: css }} />
      <div className="min-h-screen" style={{ background: "var(--loja-bg)", color: "var(--loja-text)" }}>
        {children}
      </div>
    </>
  );
}
