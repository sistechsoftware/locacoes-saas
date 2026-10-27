import { rateLimit, smallJson } from "@/lib/api-security";
import { disponibilidadeDaJanela, lojaPorSlug } from "@/lib/loja-publico";
import { janelaPadrao } from "@/lib/loja-db";
import { validarDataPedido } from "@/lib/loja";
import { today } from "@/lib/format";
import { windowError } from "@/lib/availability-time";

/**
 * Disponibilidade informativa para a data escolhida (leitura). A garantia
 * acontece na submissão e na aprovação — aqui é só orientação para o cliente.
 */
export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ip = request.headers.get("cf-connecting-ip") ?? "local";
  if (!(await rateLimit(`loja-disp:${slug}:${ip}`, 30, 60))) {
    return Response.json({ ok: false, erro: "Muitas consultas. Aguarde um minuto." }, { status: 429 });
  }
  const r = await lojaPorSlug(slug);
  if (!r.ok) return Response.json({ ok: false, erro: r.erro }, { status: r.status });
  try {
    const input = await smallJson(request, 4096);
    const data = String(input?.event_date ?? "").slice(0, 10);
    const erroData = validarDataPedido(r.loja, today(), data);
    if (erroData) return Response.json({ ok: false, erro: erroData }, { status: 422 });
    const janela = janelaPadrao(data, String(input?.event_time ?? ""));
    const erroJanela = windowError(janela.delivery_at, janela.pickup_at);
    if (erroJanela) return Response.json({ ok: false, erro: erroJanela }, { status: 422 });

    const ids = (Array.isArray(input?.product_ids) ? input.product_ids : [])
      .map((v: unknown) => Number(v))
      .filter((n: number) => Number.isInteger(n) && n > 0)
      .slice(0, 30);
    const itens = await disponibilidadeDaJanela(r.loja, ids, janela.delivery_at, janela.pickup_at);
    return Response.json({ ok: true, itens }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return Response.json({ ok: false, erro: (e as Error)?.message || "Falha na consulta." }, { status: 400 });
  }
}
