import { currentUser, type SessionUser } from "./auth";
import { AssinaturaBloqueadaError, exigirAssinaturaAtiva } from "./assinatura-gate";

/**
 * Reexportado de rate-limit.ts, onde as funcoes vivem agora: o conteudo e o
 * mesmo, e as importacoes existentes de api-security continuam funcionando.
 */
export { rateLimit, smallJson } from "./rate-limit";

/**
 * Resposta das rotas /api quando a sessão é válida mas a ASSINATURA da empresa
 * está bloqueada (pendência #05).
 *
 * 402 Payment Required, com `code` para o cliente distinguir sem parser de
 * frase: 401 continua sendo exclusivamente "sem sessão / origem inválida",
 * 402 é "você está logado, mas a empresa não pode operar".
 */
export function respostaAssinaturaBloqueada(erro?: unknown): Response {
  const mensagem =
    erro instanceof Error && erro.message
      ? erro.message
      : "Assinatura da empresa bloqueada. Regularize o pagamento em Faturamento para continuar usando o sistema.";
  return Response.json({ error: mensagem, code: "assinatura_bloqueada" }, { status: 402 });
}

/**
 * Usuario interno logado; para mutacoes exige mesma origem (CSRF).
 *
 * PENDÊNCIA #05: este e o ponto de entrada de TODA rota /api interna, entao o
 * gate de assinatura mora aqui — nenhuma rota precisa lembrar de checar.
 *
 * Três retornos, cada um com um significado próprio:
 *  * `SessionUser` — autenticado e com assinatura em ordem: siga;
 *  * `Response` (402) — sessão válida, assinatura bloqueada: a rota devolve
 *    esta resposta tal qual (`if (user instanceof Response) return user;`);
 *  * `null` — sem sessão (ou origem inválida em mutação): a rota responde
 *    401 com a mensagem que já usa hoje.
 */
export async function apiUser(
  request: Request,
  mutate = false,
): Promise<SessionUser | Response | null> {
  if (mutate && request.headers.get("origin") !== new URL(request.url).origin) return null;
  const user = await currentUser();
  if (!user) return null;
  try {
    await exigirAssinaturaAtiva(user);
  } catch (e) {
    if (e instanceof AssinaturaBloqueadaError) return respostaAssinaturaBloqueada(e);
    throw e;
  }
  return user;
}
