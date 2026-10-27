import { rateLimit, smallJson } from "@/lib/api-security";
import { calcularFreteLoja, lojaPorSlug } from "@/lib/loja-publico";

/** Estimativa de frete com a MESMA fórmula/endereço-base do painel. */
export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ip = request.headers.get("cf-connecting-ip") ?? "local";
  if (!(await rateLimit(`loja-frete:${slug}:${ip}`, 10, 60))) {
    return Response.json({ ok: false, erro: "Muitas consultas. Aguarde um minuto." }, { status: 429 });
  }
  const r = await lojaPorSlug(slug);
  if (!r.ok) return Response.json({ ok: false, erro: r.erro }, { status: r.status });
  try {
    const input = await smallJson(request, 4096);
    const frete = await calcularFreteLoja(r.loja, {
      address: String(input?.address ?? ""),
      city: String(input?.city ?? ""),
      district: String(input?.district ?? ""),
      zip: String(input?.zip ?? ""),
    });
    if (frete.ok) {
      return Response.json({ ok: true, calculado: true, valor_cents: frete.valor_cents, km: frete.km, status: "calculado" });
    }
    // Endereço incompleto é erro mesmo; falha do serviço só segue se a
    // empresa aceita envio com frete pendente de confirmação.
    const incompleto = frete.aviso.startsWith("Informe rua");
    if (incompleto || r.loja.freight_pending_ok !== 1) {
      return Response.json({ ok: false, erro: frete.aviso }, { status: 422 });
    }
    return Response.json({
      ok: true,
      calculado: false,
      status: "pendente",
      aviso: frete.aviso,
      permite_enviar: true,
    });
  } catch (e) {
    return Response.json({ ok: false, erro: (e as Error)?.message || "Não foi possível calcular o frete." }, { status: 400 });
  }
}
