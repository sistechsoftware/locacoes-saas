import { one } from "@/lib/db";
import { getFile } from "@/lib/uploads";
import { lojaPorSlug } from "@/lib/loja-publico";

const HEX32 = /^[0-9a-f]{32}$/;

/**
 * Arquivos PÚBLICOS da loja (logo, banner, fotos de produtos publicados).
 *
 * Allowlist por tenant: o arquivo só é servido se ESTA loja (empresa resolvida
 * pelo slug, no servidor) referenciá-lo na sua identidade ou nos seus produtos
 * publicados. Um id de outra empresa é indistinguível de inexistente (404).
 * Comprovantes NÃO passam por aqui — eles saem só pela rota autenticada
 * /api/arquivo com sessão da própria empresa.
 */
export async function GET(request: Request, { params }: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await params;
  if (!HEX32.test(id)) return new Response("Not found", { status: 404 });

  const r = await lojaPorSlug(slug, { requerPublicada: false });
  if (!r.ok) return new Response("Not found", { status: 404 });
  const { loja } = r;

  // Loja não publicada: imagem só para a própria empresa (prévia), igual ao layout.
  if (loja.status !== "publicada") {
    const { currentUser } = await import("@/lib/auth");
    const user = await currentUser();
    if (!user || user.company_id !== loja.company_id) return new Response("Not found", { status: 404 });
  }

  const url1 = `/api/arquivo/${id}`;
  const url2 = `/api/loja/${slug}/arquivo/${id}`;
  const referenciado = await one<{ n: number }>(
    `SELECT 1 AS n FROM company_stores s
      WHERE s.company_id = ? AND (s.logo_url IN (?,?) OR s.banner_url IN (?,?) OR s.seo_image_url IN (?,?))
     UNION ALL
     SELECT 1 AS n FROM store_products sp
      JOIN products p ON p.id = sp.product_id AND p.company_id = sp.company_id
      WHERE sp.company_id = ? AND sp.published = 1 AND (sp.photo_url IN (?,?) OR p.photo IN (?,?))
     LIMIT 1`,
    [loja.company_id, url1, url2, url1, url2, url1, url2, loja.company_id, url1, url2, url1, url2],
  );
  if (!referenciado) return new Response("Not found", { status: 404 });

  const file = await getFile(id);
  if (!file || (file as any).company_id !== loja.company_id) return new Response("Not found", { status: 404 });

  const corpo = file.data.buffer.slice(file.data.byteOffset, file.data.byteOffset + file.data.byteLength) as ArrayBuffer;
  return new Response(corpo, {
    headers: {
      "Content-Type": file.mime,
      "Content-Length": String(corpo.byteLength),
      // Publicada: cache forte (imagem não muda sem novo upload). Não publicada: privado.
      "Cache-Control": loja.status === "publicada" ? "public, max-age=86400" : "private, no-store",
    },
  });
}
