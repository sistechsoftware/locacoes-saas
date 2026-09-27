import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  abrirSessaoCliente,
  apagarSessao,
  clienteDaSessao,
  tentarLogin,
  // reexportado para as paginas: a API publica continua em portal-auth
  acessoPortalDe,
  configurarAcesso,
  gerarConviteAcesso,
  loginCliente,
  purgeExpiredPortalSessions,
  sessoesAbertasDe,
} from "./portal-core";

/**
 * Camada de requisicao do Portal do Cliente: o unico lugar que toca o cookie.
 *
 * As regras (convite, primeiro acesso, login, sessao) vivem em portal-core.ts,
 * sem next/headers nem next/navigation, para serem testaveis fora do servidor
 * do Next — o mesmo criterio de fidelidade.ts/fidelidade-db.ts no resto do
 * sistema.
 *
 * A sessao do cliente e SEPARADA da sessao do funcionario (tabela sessions e
 * cookie limas_session): cookie limas_portal, tabela portal_sessions. Um
 * cliente nunca abre a area interna com esta sessao, e um funcionario nunca
 * abre o portal com a dele.
 */

export {
  acessoPortalDe,
  configurarAcesso,
  gerarConviteAcesso,
  loginCliente,
  purgeExpiredPortalSessions,
  sessoesAbertasDe,
};

/** Cliente autenticado no portal, como as paginas consomem. */
export type ClienteSessao = {
  id: number;
  name: string;
  first_name: string;
};

const COOKIE = "limas_portal";

async function gravarCookieSessao(customerId: number) {
  const id = await abrirSessaoCliente(customerId);
  const jar = await cookies();
  jar.set(COOKIE, id, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    // a expiracao do cookie acompanha a da sessao gravada pelo core (30 dias)
    expires: new Date(Date.now() + 30 * 864e5),
    secure: process.env.NODE_ENV === "production",
  });
}

/** Encerra a sessao atual do portal, se houver. */
export async function encerrarSessaoCliente() {
  const jar = await cookies();
  const id = jar.get(COOKIE)?.value;
  if (id) await apagarSessao(id);
  jar.delete(COOKIE);
}

/**
 * Cliente logado, ou null. Le o cookie e delega a validacao ao core.
 */
export async function clienteAtual(): Promise<ClienteSessao | null> {
  const jar = await cookies();
  const id = jar.get(COOKIE)?.value;
  if (!id) return null;
  const row = await clienteDaSessao(id);
  if (!row) return null;
  const nome = row.name;
  return { id: row.id, name: nome, first_name: nome.split(/\s+/)[0] ?? nome };
}

/** Exige cliente logado; redireciona para /portal/login caso contrario. */
export async function requireCliente(): Promise<ClienteSessao> {
  const c = await clienteAtual();
  if (!c) redirect("/portal/login");
  return c;
}

/**
 * Id da sessao do portal para APIs de rota (upload/download), sem redirect.
 * As rotas /api/portal/* autenticam por aqui, no backend.
 */
export async function sessaoClienteAtual(): Promise<ClienteSessao | null> {
  return await clienteAtual();
}

/** Login: autentica pelo core e, se ok, abre a sessao e grava o cookie. */
export async function entrarPortal(cpf: string, password: string): Promise<string | null> {
  const { erro, customerId } = await tentarLogin(cpf, password);
  if (erro || !customerId) return erro ?? "Não foi possível entrar.";
  await gravarCookieSessao(customerId);
  return null;
}
