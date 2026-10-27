import { rateLimit, smallJson } from "@/lib/api-security";
import { criarPedidoPublico } from "@/lib/loja-publico";

/**
 * Criação de solicitação pública da loja. Sem sessão: as barreiras são
 * (1) a loja publicada + recurso liberado resolvidos pelo slug no servidor,
 * (2) rate limit por IP+slug, (3) recálculo total de preços, período,
 * frete e disponibilidade no backend — o navegador nunca fixa valor.
 */
export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ip = request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for") ?? "local";
  if (!(await rateLimit(`loja-pedido:${slug}:${ip}`, 5, 60))) {
    return Response.json({ ok: false, erro: "Muitas tentativas. Aguarde um minuto e tente novamente." }, { status: 429 });
  }
  try {
    const input = await smallJson(request, 16_384);
    const r = await criarPedidoPublico(
      {
        slug,
        itens: Array.isArray(input?.itens) ? input.itens : [],
        cliente: (input?.cliente ?? {}) as any,
        event_date: String(input?.event_date ?? ""),
        event_time: String(input?.event_time ?? ""),
        modalidade: input?.modalidade === "retirada" ? "retirada" : "entrega",
        endereco: input?.endereco,
        observacoes: String(input?.observacoes ?? ""),
        aceitou_termos: input?.aceitou_termos === true,
      },
      { ip },
    );
    if (!r.ok) return Response.json(r, { status: 400 });
    return Response.json(r, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    const msg = (e as Error)?.message || "Não foi possível processar o pedido.";
    if (msg.includes("Requisição muito grande")) {
      return Response.json({ ok: false, erro: msg }, { status: 413 });
    }
    if (msg.includes("JSON")) return Response.json({ ok: false, erro: "Requisição inválida." }, { status: 400 });
    console.error("[loja] falha ao criar pedido:", msg);
    return Response.json({ ok: false, erro: "Não foi possível processar o pedido. Tente novamente." }, { status: 500 });
  }
}
