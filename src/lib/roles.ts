import "server-only";

/**
 * Papéis da plataforma (migration 0027).
 *
 * A conversão preservou o poder de quem já usava o sistema:
 *   admin (antigo, primeiro) -> owner   |  admin (antigo) -> admin
 *   operador (antigo)        -> operacional
 *
 * A matriz abaixo é o mapa server-side v1: módulos × papéis. Permissões
 * granulares (ver/criar/editar/excluir por módulo) ficam para uma fase
 * futura — a estrutura de papéis já nasce preparada para isso.
 */

export type Role = "owner" | "admin" | "operacional" | "financeiro" | "viewer";

export type Module =
  | "dashboard"
  | "agenda"
  | "clientes"
  | "produtos"
  | "estoque"
  | "reservas"
  | "orcamentos"
  | "contratos"
  | "recibos"
  | "operacao"
  | "fretes"
  | "financeiro"
  | "compras"
  | "promocoes"
  | "fidelidade"
  | "chat"
  | "relatorios"
  | "notificacoes"
  | "configuracoes"
  | "usuarios"
  | "assinatura"
  | "erros";

/** Papéis que podem visualizar cada módulo. Escrita exige edição (abaixo). */
const VIEW: Record<Module, readonly Role[]> = {
  dashboard:     ["owner", "admin", "operacional", "financeiro", "viewer"],
  agenda:        ["owner", "admin", "operacional", "financeiro", "viewer"],
  clientes:      ["owner", "admin", "operacional", "financeiro", "viewer"],
  produtos:      ["owner", "admin", "operacional", "viewer"],
  estoque:       ["owner", "admin", "operacional", "viewer"],
  reservas:      ["owner", "admin", "operacional", "financeiro", "viewer"],
  orcamentos:    ["owner", "admin", "operacional", "financeiro", "viewer"],
  contratos:     ["owner", "admin", "operacional", "viewer"],
  recibos:       ["owner", "admin", "operacional", "financeiro", "viewer"],
  operacao:      ["owner", "admin", "operacional", "viewer"],
  fretes:        ["owner", "admin", "operacional", "financeiro", "viewer"],
  financeiro:    ["owner", "admin", "financeiro"],
  compras:       ["owner", "admin", "operacional", "financeiro", "viewer"],
  promocoes:     ["owner", "admin", "operacional", "viewer"],
  fidelidade:    ["owner", "admin", "operacional", "viewer"],
  chat:          ["owner", "admin", "operacional", "financeiro", "viewer"],
  relatorios:    ["owner", "admin", "financeiro", "viewer"],
  notificacoes:  ["owner", "admin", "operacional", "financeiro", "viewer"],
  configuracoes: ["owner", "admin"],
  usuarios:      ["owner", "admin"],
  assinatura:    ["owner", "admin"],
  erros:         ["owner", "admin"],
};

/** Papéis que podem alterar dados de cada módulo (server-side, em toda escrita). */
const EDIT: Record<Module, readonly Role[]> = {
  dashboard:     [],
  agenda:        ["owner", "admin", "operacional"],
  clientes:      ["owner", "admin", "operacional"],
  produtos:      ["owner", "admin", "operacional"],
  estoque:       ["owner", "admin", "operacional"],
  reservas:      ["owner", "admin", "operacional"],
  orcamentos:    ["owner", "admin", "operacional"],
  contratos:     ["owner", "admin", "operacional"],
  recibos:       ["owner", "admin", "operacional", "financeiro"],
  operacao:      ["owner", "admin", "operacional"],
  fretes:        ["owner", "admin", "operacional"],
  financeiro:    ["owner", "admin", "financeiro"],
  compras:       ["owner", "admin", "operacional"],
  promocoes:     ["owner", "admin", "operacional"],
  fidelidade:    ["owner", "admin", "operacional"],
  chat:          ["owner", "admin", "operacional", "financeiro", "viewer"],
  relatorios:    [],
  notificacoes:  ["owner", "admin", "operacional", "financeiro"],
  /*
   * Administrador da Empresa (owner OU admin) administra a PRÓPRIA empresa:
   * dados, modelos, usuários e assinatura. O que fica fora do alcance dele é
   * a PLATAFORMA (painel /saas, outras empresas, Asaas global) — isso é
   * users.platform_admin, não papel de empresa.
   */
  configuracoes: ["owner", "admin"],
  usuarios:      ["owner", "admin"],
  assinatura:    ["owner", "admin"],
  erros:         ["owner", "admin"],
};

/** O papel pode VER o módulo? */
export function canView(role: Role, module: Module): boolean {
  return VIEW[module].includes(role);
}

/** O papel pode ALTERAR dados do módulo? */
export function canEdit(role: Role, module: Module): boolean {
  return EDIT[module].includes(role);
}

/** Ação crítica (excluir/apagar/permanente)? Dono/admin, sem exceção. */
export function isDestructive(role: Role): boolean {
  return role === "owner" || role === "admin";
}

/**
 * Equivalência administrativa (owner + admin).
 *
 * O código herdado compara `role === "admin"`; com os papéis v1, o dono da
 * empresa precisa passar nas mesmas checagens — na interface E nas server
 * actions. Use esta função em vez da comparação literal.
 */
export function ehAdmin(role: Role): boolean {
  return role === "owner" || role === "admin";
}

/** Módulos visíveis para o papel — usado pelo menu do Shell. */
export function modulesFor(role: Role): Module[] {
  return (Object.keys(VIEW) as Module[]).filter((m) => canView(role, m));
}
