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
