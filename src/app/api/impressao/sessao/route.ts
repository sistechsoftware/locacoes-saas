import { apiUser, rateLimit, smallJson } from "@/lib/api-security";
import { destinoInterno } from "@/lib/destino";
import { criarSessaoDeImpressao } from "@/lib/impressao-sessao";

/**
 * Prepara a abertura do documento no Safari do iPhone (POST autenticado).
 *
 * O app instalado e o Safari não compartilham cookies no iOS, mas quem pede a
 * impressão já está logado no app — então o servidor emite uma sessão CURTA do
 * próprio usuário e devolve o caminho `/sessao-impressao?s=…&proximo=…`. O
 * cliente abre esse caminho no Safari; a rota adota o cookie e cai no
 * documento, já autenticado e com `?imprimir=1`.
 *
 * Só emite sessão para caminho INTERNO (destinoInterno) — o token não serve
 * como redirecionador aberto.
 */
export async function POST(request: Request) {
  const user = await apiUser(request, true);
  if (user instanceof Response) return user;
  if (!user) return Response.json({ error: "Sessão expirada ou origem inválida." }, { status: 401 });
  try {
    // cada chamada grava uma sessão curta: o limite evita que um laço do
    // cliente encha a tabela
    if (!(await rateLimit(`sessao-impressao:${user.id}`, 30))) {
      return Response.json({ error: "Aguarde um minuto." }, { status: 429 });
    }
    const input = await smallJson(request);
    const proximo = destinoInterno(typeof input.proximo === "string" ? input.proximo : "", "");
    if (!proximo) return Response.json({ error: "Documento inválido." }, { status: 400 });

    const { id } = await criarSessaoDeImpressao(user.id);
    const caminho = `/sessao-impressao?s=${id}&proximo=${encodeURIComponent(proximo)}`;
    return Response.json({ ok: true, caminho }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : "Não foi possível preparar a impressão." },
      { status: 400 },
    );
  }
}
