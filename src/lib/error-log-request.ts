import "server-only";
import { one } from "./db";

/**
 * Usuario da request que falhou, lido direto do header cookie.
 *
 * O hook onRequestError nao roda dentro de um Server Component: next/headers()
 * nao esta disponivel la. A sessao e um cookie simples apontando para a tabela
 * sessions, entao ler o header e consultar o banco resolve sem depender do
 * contexto do React — e sem importar auth.ts, que puxa redirect/cookies.
 */
const COOKIE = "limas_session";

export async function getUsuarioDaRequest(
  headers: Record<string, string | string[] | undefined>,
): Promise<{ id: number; name: string } | null> {
  const bruto = headers?.cookie;
  const texto = Array.isArray(bruto) ? bruto.join("; ") : bruto ?? "";
  const m = texto.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!m) return null;
  const row = await one<{ id: number; name: string }>(
    `SELECT u.id, u.name FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`,
    [m[1]],
  );
  return row ?? null;
}
