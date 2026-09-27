import { rateLimit } from "@/lib/api-security";
import { assinar } from "@/lib/assinatura-db";
import { MAX_ASSINATURA_BYTES } from "@/lib/assinatura";

/**
 * Assinatura vinda da pagina publica.
 *
 * Esta e a unica rota do sistema aberta para a internet sem login, entao ela
 * trata tudo como hostil: limite de tentativas por IP, corpo com tamanho
 * maximo, e toda a regra revalidada no servico, nunca confiando no que a tela
 * mandou. O token nao aparece em log nem em mensagem de erro.
 */
export async function POST(request: Request) {
  const ip = request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for") ?? "";

  // trava a forca bruta de token sem punir quem so errou o desenho
  if (!(await rateLimit(`assinar:${ip || "sem-ip"}`, 10))) {
    return Response.json({ erro: "Muitas tentativas. Aguarde um minuto." }, { status: 429 });
  }

  let corpo: any;
  try {
    const texto = await request.text();
    if (texto.length > MAX_ASSINATURA_BYTES + 4096) {
      return Response.json({ erro: "Assinatura muito pesada." }, { status: 413 });
    }
    corpo = JSON.parse(texto);
  } catch {
    return Response.json({ erro: "Requisição inválida." }, { status: 400 });
  }

  const resultado = await assinar(
    String(corpo?.token ?? ""),
    {
      nome: String(corpo?.nome ?? ""),
      aceite: corpo?.aceite === true,
      imagem: String(corpo?.imagem ?? ""),
    },
    { ip, userAgent: request.headers.get("user-agent") },
  );

  if (resultado.erro) return Response.json({ erro: resultado.erro }, { status: 400 });
  return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
