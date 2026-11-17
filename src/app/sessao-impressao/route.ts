import { NextResponse } from "next/server";
import { adotarSessao } from "@/lib/auth";
import { destinoInterno } from "@/lib/destino";
import { sessaoDeImpressao } from "@/lib/impressao-sessao";

export const dynamic = "force-dynamic";

/**
 * Porta de entrada do Safari para a impressão no iPhone.
 *
 * Recebe a sessão curta emitida por /api/impressao/sessao, adota o cookie
 * NESTE navegador (o Safari tem jar próprio, separado do app instalado) e
 * redireciona para o documento — que já carrega `?imprimir=1` e abre a folha
 * de impressão sozinho. O usuário não digita senha: ele já estava autenticado
 * no app que pediu a impressão.
 *
 * Sempre redireciona (nunca serve conteúdo): sessão inválida/expirada cai no
 * /login normal; `proximo` só aceita caminho interno (destinoInterno).
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const proximo = destinoInterno(url.searchParams.get("proximo") ?? "", "");
  const sessao = proximo ? await sessaoDeImpressao(url.searchParams.get("s") ?? "") : null;
  if (!sessao) return NextResponse.redirect(new URL("/login", url.origin));

  await adotarSessao(sessao.id, sessao.expiraEm);
  const resposta = NextResponse.redirect(new URL(proximo, url.origin));
  // a URL com a sessão não pode ficar em cache de intermediário
  resposta.headers.set("Cache-Control", "no-store");
  return resposta;
}
