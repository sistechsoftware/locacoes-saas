import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { one } from "./db";
import { registrarNegacao, temRecurso } from "./plano-gate";
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
  /** Empresa do cliente (da sessao, migration 0027). */
  company_id: number;
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
  return { id: row.id, name: nome, first_name: nome.split(/\s+/)[0] ?? nome, company_id: row.company_id };
}

/** Exige cliente logado; redireciona para /portal/login caso contrario. */
export async function requireCliente(): Promise<ClienteSessao> {
  const c = await clienteAtual();
  if (!c) redirect("/portal/login");
  // GATE DE RECURSOS CONTRATADOS: o Portal do Cliente é um item pago
  // (profissional+). A sessão do cliente não depende do plano, mas o
  // CONTEÚDO do portal sim — uma empresa que não contratou o portal não
  // pode exibir histórico, contratos e documentos pelo portal. A mensagem
  // é discreta e não expõe o plano (o cliente não é quem negocia upgrade).
  if (!(await temRecurso({ company_id: c.company_id, platform_admin: false }, "portal"))) {
    registrarNegacao(c.company_id, "portal", "portal-pagina");
    redirect("/portal/login?bloqueio=plano");
  }
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
  // Portal fora do plano contratado: nem abre sessão. Mensagem discreta —
  // quem decide o upgrade é a equipe da empresa, não o cliente final.
  const empresa = await one<{ company_id: number }>(`SELECT company_id FROM customers WHERE id = ?`, [customerId]);
  if (
    empresa &&
    !(await temRecurso({ company_id: empresa.company_id, platform_admin: false }, "portal"))
  ) {
    registrarNegacao(empresa.company_id, "portal", "portal-login");
    return "O portal está indisponível no momento. Fale com a locadora.";
  }
  await gravarCookieSessao(customerId);
  return null;
}
