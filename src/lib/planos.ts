/**
 * FONTE ÚNICA DE VERDADE dos planos comerciais do Locô e dos recursos que
 * cada plano inclui (Etapa 2 da correção de planos).
 *
 * Módulo PURO — sem banco, sem next/* — porque é consumido pelo servidor
 * (gates de página/action/API) E pelo cliente (filtro do menu). A matriz
 * comercial vive SÓ aqui: nenhuma comparação `if (plano === "empresarial")`
 * pode existir em outro arquivo.
 *
 * Regras de autorização:
 *  * a autorização usa exclusivamente o slug ESTÁVEL gravado na assinatura da
 *    empresa (subscriptions.plan_id -> plans.slug), resolvido no servidor;
 *  * preço, nome de exibição, texto promocional, localStorage, flags de
 *    interface e parâmetros de URL NUNCA participam de decisão de acesso;
 *  * herança comercial: um plano superior inclui todos os recursos dos
 *    inferiores (profissional ⊃ essencial; empresarial ⊃ profissional);
 *  * sem plano conhecido (catálogo vazio, assinatura sem plano, slug
 *    desconhecido), apenas os recursos FUNDAMENTAIS seguem disponíveis —
 *    recursos pagos são fail-closed (nunca abrem por ausência de restrição).
 */

export type PlanoSlug = "essencial" | "profissional" | "empresarial";

/**
 * Recursos comerciais do sistema. Os módulos internos não listados aqui
 * (dashboard, agenda, operação, compras, promoções, notificações, configurações,
 * usuários, assinatura, recibos, busca, histórico...) são FUNDAMENTAIS: todo
 * plano pode usá-los — não inventamos limitações comerciais fora da oferta.
 */
export type Recurso =
  | "reservas"
  | "orcamentos"
  | "clientes"
  | "estoque"
  | "financeiro"
  | "portal"
  | "chat"
  | "relatorios"
  | "fidelidade"
  | "fretes"
  | "contratos"
  | "suporte";

/** Ordem comercial crescente (herança por posição). */
export const ORDEM_PLANOS: readonly PlanoSlug[] = ["essencial", "profissional", "empresarial"];

export const NOME_DO_PLANO: Record<PlanoSlug, string> = {
  essencial: "Essencial",
  profissional: "Profissional",
  empresarial: "Empresarial",
};

export type DefinicaoRecurso = {
  /** Nome exibido nas mensagens de bloqueio. */
  nome: string;
  /** Menor plano que inclui o recurso (herança comercial a partir dele). */
  minimo: PlanoSlug;
  /** true = recurso fundamental, incluído em qualquer plano (inclusive
   *  quando o sistema não tem plano conhecido para a empresa). */
  fundamental: boolean;
};

/**
 * MATRIZ OFICIAL (Etapa 3). Os cinco primeiros são a base contratada de
 * qualquer plano; os demais entram conforme o plano cresce.
 */
export const RECURSOS: Record<Recurso, DefinicaoRecurso> = {
  reservas: { nome: "Reservas", minimo: "essencial", fundamental: true },
  orcamentos: { nome: "Orçamentos", minimo: "essencial", fundamental: true },
  clientes: { nome: "Clientes", minimo: "essencial", fundamental: true },
  estoque: { nome: "Estoque", minimo: "essencial", fundamental: true },
  financeiro: { nome: "Financeiro", minimo: "essencial", fundamental: true },
  portal: { nome: "Portal do Cliente", minimo: "profissional", fundamental: false },
  chat: { nome: "Mensagens (chat)", minimo: "profissional", fundamental: false },
  relatorios: { nome: "Relatórios", minimo: "profissional", fundamental: false },
  fidelidade: { nome: "Fidelidade", minimo: "profissional", fundamental: false },
  fretes: { nome: "Fretes", minimo: "empresarial", fundamental: false },
  contratos: { nome: "Contratos", minimo: "empresarial", fundamental: false },
  // Sem módulo próprio no sistema hoje: registrado para a oferta não se
  // perder da matriz; quando a tela existir, a autorização já sai daqui.
  suporte: { nome: "Suporte prioritário", minimo: "empresarial", fundamental: false },
};

export function ehPlanoValido(slug: unknown): slug is PlanoSlug {
  return typeof slug === "string" && (ORDEM_PLANOS as readonly string[]).includes(slug);
}

/** O plano (slugs conhecidos) inclui o recurso? Sem plano conhecido, só os fundamentais. */
export function planoInclui(slug: string | null | undefined, recurso: Recurso): boolean {
  const def = RECURSOS[recurso];
  if (!ehPlanoValido(slug)) return def.fundamental;
  return ORDEM_PLANOS.indexOf(slug) >= ORDEM_PLANOS.indexOf(def.minimo);
}

/** Menor plano que libera um recurso (usado nas mensagens de upgrade). */
export function planoMinimoPara(recurso: Recurso): PlanoSlug {
  return RECURSOS[recurso].minimo;
}

/** Nome de exibição do plano (para mensagens). */
export function nomeDoPlano(slug: string | null | undefined): string {
  return ehPlanoValido(slug) ? NOME_DO_PLANO[slug] : "não identificado";
}

/**
 * Recurso comercial exigido por um CAMINHO interno (hrefs do menu e das
 * páginas). Caminho sem recurso pago = fundamental (nada a verificar).
 */
export function recursoDoCaminho(caminho: string): Recurso | null {
  const p = caminho.split("?")[0].replace(/\/$/, "") || "/";
  const bases: [string, Recurso][] = [
    ["/chat", "chat"],
    ["/fidelidade", "fidelidade"],
    ["/relatorios", "relatorios"],
    ["/fretes", "fretes"],
    ["/contratos", "contratos"],
  ];
  for (const [base, recurso] of bases) {
    if (p === base || p.startsWith(`${base}/`)) return recurso;
  }
  return null;
}

/**
 * Recurso comercial exigido por uma ROTA /api interna (derivado do caminho da
 * própria requisição — o handler roda amarrado ao path, não existe "path
 * forjado" aqui).
 *
 * `/api/routes` fica de fora DE PROPÓSITO: o cálculo de rota por endereço é
 * compartilhado entre reservas/orçamentos (base) e o módulo de Fretes —
 * decisão registrada na correção de planos. `/api/portal/*` é autenticado
 * pelo próprio portal (não por apiUser) e é barrado nas rotas.
 */
export function recursoDaApi(caminho: string): Recurso | null {
  const p = caminho.split("?")[0];
  if (p === "/api/chat" || p.startsWith("/api/chat/")) return "chat";
  if (p.startsWith("/api/portal/")) return "portal";
  return null;
}

/**
 * Um item de menu/atalho fica visível para o plano?
 * `undefined` = sem restrição (operador da plataforma); `null` = plano
 * desconhecido → só o que for fundamental.
 */
export function visivelParaPlano(caminho: string, planoSlug: string | null | undefined): boolean {
  const recurso = recursoDoCaminho(caminho);
  if (!recurso) return true;
  if (planoSlug === undefined) return true;
  return planoInclui(planoSlug, recurso);
}
