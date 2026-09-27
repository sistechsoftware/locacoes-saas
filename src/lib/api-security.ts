import { currentUser } from "./auth";

/**
 * Reexportado de rate-limit.ts, onde as funcoes vivem agora: o conteudo e o
 * mesmo, e as importacoes existentes de api-security continuam funcionando.
 */
export { rateLimit, smallJson } from "./rate-limit";

/** Usuario interno logado; para mutacoes exige mesma origem (CSRF). */
export async function apiUser(request: Request, mutate = false) {
  if (mutate && request.headers.get("origin") !== new URL(request.url).origin) return null;
  return currentUser();
}
