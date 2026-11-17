import "server-only";
import crypto from "node:crypto";
import { one, run } from "./db";

/**
 * Sessão de impressão — a ponte entre o app instalado e o Safari no iPhone.
 *
 * O iOS isola o armazenamento do app instalado do Safari (os cookies são
 * copiados UMA vez, na instalação, e depois cada um tem o seu jar). Como a
 * impressão do iOS 27 só funciona no Safari, o documento aberto lá chegaria
 * deslogado — mas quem pediu a impressão JÁ está autenticado no app, então
 * pedir login de novo não faz sentido.
 *
 * Esta é a ponte: o app pede ao servidor uma sessão curta do PRÓPRIO usuário
 * (mesma tabela `sessions`, nenhuma migração) e a leva na URL de abertura do
 * Safari. `/sessao-impressao` adota o cookie e redireciona para o documento,
 * que então é servido normalmente, com o mesmo `requireModule` de sempre.
 *
 * Validade curta de propósito: a credencial viaja na URL, então vale só para
 * aquele pedido de impressão e expira em minutos. A sessão longa do app
 * instalado nunca sai do cookie httpOnly dele.
 */
export const VALIDADE_MINUTOS = 10;

export type SessaoDeImpressao = { id: string; expiraEm: Date };

/** Cria a sessão curta de impressão para o usuário logado. */
export async function criarSessaoDeImpressao(userId: number): Promise<SessaoDeImpressao> {
  const id = crypto.randomBytes(32).toString("hex");
  const expiraEm = new Date(Date.now() + VALIDADE_MINUTOS * 60e3);
  await run("INSERT INTO sessions (id, user_id, expires_at) VALUES (?,?,?)", [
    id,
    userId,
    expiraEm.toISOString(),
  ]);
  return { id, expiraEm };
}

/**
 * Sessão de impressão ainda válida.
 *
 * Só aceita o formato que `criarSessaoDeImpressao` emite (64 hex) e recusa
 * sessão expirada — o resto (usuário inativo, empresa inativa, prazo) continua
 * sendo cobrado pelo `requireModule` da própria página, com o cookie já posto.
 */
export async function sessaoDeImpressao(
  id: string,
): Promise<{ id: string; userId: number; expiraEm: Date } | null> {
  if (!/^[a-f0-9]{64}$/.test(id)) return null;
  const row = await one<{ user_id: number; expires_at: string }>(
    "SELECT user_id, expires_at FROM sessions WHERE id = ?",
    [id],
  );
  if (!row) return null;
  const expiraEm = new Date(row.expires_at);
  if (!(expiraEm.getTime() > Date.now())) return null;
  return { id, userId: row.user_id, expiraEm };
}
