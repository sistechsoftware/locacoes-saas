/**
 * Destino pós-login conforme o perfil autenticado.
 *
 * Função PURA (sem next/*, sem server-only): o node:test precisa importá-la
 * diretamente — mesmo padrão de password.ts. auth.ts reexporta para os
 * chamadores (login, setup, assinar, páginas públicas).
 *
 *  * platform_admin -> /saas (ambiente administrativo da plataforma);
 *  * qualquer outro papel -> /dashboard (ambiente operacional do locador).
 */
export function destinoAposLogin(u: { platform_admin: boolean }): string {
  return u.platform_admin ? "/saas" : "/dashboard";
}

/**
 * Destino INTERNO seguro para o `proximo` do login (volta para onde o usuario
 * estava indo).
 *
 * Existe por um caso concreto do iOS: o app instalado e o Safari tem cookie
 * jars SEPARADOS (isolamento por design desde o iOS 11), entao a impressao que
 * sai do PWA abre o Safari sem sessao. O link leva `/login?proximo=<documento>`
 * e, depois de autenticar, o usuario cai no documento em vez do /dashboard.
 *
 * Função PURA e restritiva de proposito — `proximo` vem da URL e alimenta um
 * `redirect()`: so caminho absoluto do proprio site (nunca host, esquema ou
 * "//"), sem caracteres de controle, e nunca de volta para as telas de
 * autenticacao (isso criaria laco). Qualquer outra coisa cai no `padrao`.
 */
export function destinoInterno(valor: string | null | undefined, padrao: string): string {
  if (typeof valor !== "string") return padrao;
  const v = valor.trim();
  if (v.length === 0 || v.length > 400) return padrao;
  if (!v.startsWith("/") || v.startsWith("//")) return padrao;
  if (v.includes("\\") || /[\u0000-\u001f]/.test(v)) return padrao;
  if (/^\/(login|redefinir-senha|recuperar-senha)(?:[/?#]|$)/.test(v)) return padrao;
  return v;
}
