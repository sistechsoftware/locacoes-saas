import { NextResponse } from "next/server";
import { mensagemDeErro, registrarErro } from "@/lib/error-log";
import { rateLimit } from "@/lib/api-security";

/**
 * Diario de erros do lado do cliente (boundary de erro do React).
 *
 * A tela de erro manda o resumo aqui e o operador ve tudo junto em /erros,
 * sem precisar do console do navegador de quem usou o sistema. Endpoint
 * publico DE PROPOSITO: o erro pode ter acontecido exatamente na sessao que
 * caiu. A blindagem e por volume (rate limit) e por forma (payload minimo,
 * campos curtos) — nao por login.
 */
export async function POST(request: Request) {
  if (!(await rateLimit("log-erro", 30, 300))) return new Response(null, { status: 429 });

  let body: any = null;
  try {
    body = await request.json();
  } catch {
    return new Response(null, { status: 400 });
  }

  const message = typeof body?.message === "string" ? body.message : "";
  if (!message) return new Response(null, { status: 400 });

  await registrarErro({
    source: "api/log-erro",
    kind: "client",
    message: mensagemDeErro(message),
    digest: typeof body?.digest === "string" ? body.digest : null,
    route: typeof body?.route === "string" ? body.route : null,
    context: {
      url: typeof body?.url === "string" ? body.url.slice(0, 2000) : null,
      userAgent: request.headers.get("user-agent")?.slice(0, 400) ?? null,
    },
  });

  return NextResponse.json({ ok: true });
}
