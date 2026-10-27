import { rateLimit } from "@/lib/api-security";
import { enviarComprovante } from "@/lib/loja-publico";

/**
 * Envio de comprovante pelo cliente público (token de acompanhamento).
 * Validação de tipo/tamanho está em loja.ts (comprovanteAceito); o arquivo é
 * gravado em `files` escopado pela empresa e nunca vira URL pública.
 */
export async function POST(request: Request, { params }: { params: Promise<{ slug: string; token: string }> }) {
  const { slug, token } = await params;
  const ip = request.headers.get("cf-connecting-ip") ?? "local";
  if (!(await rateLimit(`loja-comprovante:${slug}:${ip}`, 5, 60))) {
    return Response.json({ ok: false, erro: "Muitos envios. Aguarde um minuto." }, { status: 429 });
  }
  try {
    const form = await request.formData().catch(() => null);
    const arquivo = form?.get("comprovante");
    if (!arquivo || typeof arquivo === "string") {
      return Response.json({ ok: false, erro: "Selecione o arquivo do comprovante." }, { status: 400 });
    }
    const r = await enviarComprovante(slug, token, arquivo as File);
    if (!r.ok) return Response.json(r, { status: 400 });
    return Response.json(r, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[loja] falha no comprovante:", (e as Error)?.message);
    return Response.json({ ok: false, erro: "Não foi possível enviar o comprovante. Tente novamente." }, { status: 500 });
  }
}
