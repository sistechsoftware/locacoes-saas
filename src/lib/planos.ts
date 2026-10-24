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

/**
 * Categorias do catálogo — agrupamento da UI do painel /saas e da oferta
 * pública. São rótulos de apresentação; a autorização continua decidida pela
 * matriz RECURSOS + precedência abaixo.
 */
export type CategoriaRecurso = "operacao" | "relacionamento" | "gestao";

export const NOME_DA_CATEGORIA: Record<CategoriaRecurso, string> = {
  operacao: "Operação do dia",
  relacionamento: "Relacionamento com o cliente",
  gestao: "Gestão e expansão",
};

export type DefinicaoRecurso = {
  /** Nome exibido nas mensagens de bloqueio. */
  nome: string;
  /** Menor plano que inclui o recurso (herança comercial a partir dele). */
  minimo: PlanoSlug;
  /** true = recurso fundamental, incluído em qualquer plano (inclusive
   *  quando o sistema não tem plano conhecido para a empresa). */
  fundamental: boolean;
  /** Categoria de apresentação (UI do painel e da oferta). */
  categoria: CategoriaRecurso;
  /** Texto curto para o painel administrativo explicar o que é. */
  descricao: string;
};

/**
 * MATRIZ OFICIAL (Etapa 3). Os cinco primeiros são a base contratada de
 * qualquer plano; os demais entram conforme o plano cresce.
 */
export const RECURSOS: Record<Recurso, DefinicaoRecurso> = {
  reservas: { nome: "Reservas", minimo: "essencial", fundamental: true, categoria: "operacao", descricao: "Agendamento de itens, disponibilidade e operação do dia." },
  orcamentos: { nome: "Orçamentos", minimo: "essencial", fundamental: true, categoria: "operacao", descricao: "Propostas comerciais para clientes." },
  clientes: { nome: "Clientes", minimo: "essencial", fundamental: true, categoria: "operacao", descricao: "Cadastro e histórico de clientes." },
  estoque: { nome: "Estoque", minimo: "essencial", fundamental: true, categoria: "operacao", descricao: "Produtos, kits e controle de entrada e saída." },
  financeiro: { nome: "Financeiro", minimo: "essencial", fundamental: true, categoria: "operacao", descricao: "Contas a pagar e receber, fluxo de caixa." },
  portal: { nome: "Portal do Cliente", minimo: "profissional", fundamental: false, categoria: "relacionamento", descricao: "Área do cliente para acompanhar reservas e documentos." },
  chat: { nome: "Mensagens (chat)", minimo: "profissional", fundamental: false, categoria: "relacionamento", descricao: "Mensagens internas da equipe com arquivos." },
  relatorios: { nome: "Relatórios", minimo: "profissional", fundamental: false, categoria: "gestao", descricao: "Relatórios de desempenho e financeiros." },
  fidelidade: { nome: "Fidelidade", minimo: "profissional", fundamental: false, categoria: "relacionamento", descricao: "Programa de pontos e recompensas." },
  fretes: { nome: "Fretes", minimo: "empresarial", fundamental: false, categoria: "operacao", descricao: "Gestão e cálculo de fretes com rota." },
  contratos: { nome: "Contratos", minimo: "empresarial", fundamental: false, categoria: "gestao", descricao: "Contratos com assinatura digital." },
  // Sem módulo próprio no sistema hoje: registrado para a oferta não se
  // perder da matriz; quando a tela existir, a autorização já sai daqui.
  suporte: { nome: "Suporte prioritário", minimo: "empresarial", fundamental: false, categoria: "gestao", descricao: "Atendimento com prioridade na fila de suporte." },
};

export const LISTA_RECURSOS: Recurso[] = Object.keys(RECURSOS) as Recurso[];

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

/* ------------------------------------------------------------------ */
/* Personalização por empresa (painel /saas) — precedência central      */
/* ------------------------------------------------------------------ */

/**
 * Ajuste administrativo permanente de UMA funcionalidade para UMA empresa
 * (company_feature_overrides, migration 0039).
 *  * "allow" — libera além do plano contratado;
 *  * "block" — excepciona uma funcionalidade que o plano inclui.
 */
export type AjusteRecurso = "allow" | "block";

/** De onde veio a permissão efetiva — exibido no painel e nos testes. */
export type OrigemPermissao =
  | "fundamental"
  | "bloqueio_admin"
  | "plano"
  | "liberacao_admin"
  | "cortesia"
  | "nao_incluido";

export type ResolucaoRecurso = { liberado: boolean; origem: OrigemPermissao };

/**
 * PRECEDÊNCIA ÚNICA e central de toda permissão de funcionalidade. Toda
 * decisão — gate do backend, estado exibido no painel e filtro do menu —
 * passa por aqui, para nunca divergir.
 *
 * Ordem (documentada como regra de negócio):
 *  1. BLOQUEIO administrativo individual — prevalece sobre tudo (plano,
 *     cortesia e até recurso fundamental): é uma exceção explícita,
 *     auditada, que o operador da plataforma assumiu ao bloquear;
 *  2. RECURSO FUNDAMENTAL — base de qualquer plano, sempre aberto;
 *  3. PLANO CONTRATADO — a matriz herança comercial (planos.ts);
 *  4. LIBERAÇÃO administrativa permanente — benefício concedido sem troca
 *     de plano e sem cobrança nova; sobrevive a renovações e trocas de plano
 *     porque mora nesta tabela, não na assinatura;
 *  5. CORTESIA ativa — libera os recursos do plano-referência enquanto a
 *     vigência durar; ao expirar, esta camada some sozinha (o estado é
 *     derivado do tempo) e o que resta é 1–4;
 *  6. caso contrário, NÃO INCLUÍDO (fail-closed para recursos pagos).
 *
 * Nota de segurança: uma cortesia NÃO contorna o gate de ASSINATURA
 * (suspensa/cancelada/trial expirado) — esse bloqueio é aplicado nos pontos
 * de entrada (requireUser/apiUser) antes de qualquer recurso ser resolvido.
 */
export function resolverPermissao(entrada: {
  recurso: Recurso;
  /** Ajuste administrativo permanente desta empresa, se houver. */
  ajuste?: AjusteRecurso | null;
  /** O plano contratado inclui o recurso (herança comercial). */
  planoInclui: boolean;
  /** Uma cortesia ATIVA cobre o recurso no momento. */
  cortesiaInclui?: boolean;
}): ResolucaoRecurso {
  const def = RECURSOS[entrada.recurso];
  if (entrada.ajuste === "block") return { liberado: false, origem: "bloqueio_admin" };
  if (def.fundamental) return { liberado: true, origem: "fundamental" };
  if (entrada.planoInclui) return { liberado: true, origem: "plano" };
  if (entrada.ajuste === "allow") return { liberado: true, origem: "liberacao_admin" };
  if (entrada.cortesiaInclui) return { liberado: true, origem: "cortesia" };
  return { liberado: false, origem: "nao_incluido" };
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
 *
 * `/api/geocode` e `/api/routes/opcoes` são da calculadora de frete (Menu + >
 * Calcular Frete) e seguem o mesmo portão do módulo de Fretes.
 */
export function recursoDaApi(caminho: string): Recurso | null {
  const p = caminho.split("?")[0];
  if (p === "/api/chat" || p.startsWith("/api/chat/")) return "chat";
  if (p.startsWith("/api/portal/")) return "portal";
  if (p === "/api/geocode" || p === "/api/routes/opcoes") return "fretes";
  return null;
}

/**
 * Ajustes de menu vindos do servidor (overrides + cortesia ativa da empresa).
 * Só apresentação: a porta de verdade é o backend.
 */
export type AjustesMenu = {
  /** Recursos liberados além do plano (allow ou cortesia vigente). */
  extras: Recurso[];
  /** Recursos excepcionalmente bloqueados para a empresa. */
  bloqueados: Recurso[];
};

/**
 * Um item de menu/atalho fica visível para o plano?
 * `undefined` = sem restrição (operador da plataforma); `null` = plano
 * desconhecido → só o que for fundamental.
 *
 * `ajustes` opcional aplica as personalizações da empresa (liberações e
 * bloqueios administrativos, cortesia vigente) — sem ele o filtro é
 * exatamente o antigo, por plano.
 */
export function visivelParaPlano(
  caminho: string,
  planoSlug: string | null | undefined,
  ajustes?: AjustesMenu | null,
): boolean {
  const recurso = recursoDoCaminho(caminho);
  if (!recurso) return true;
  if (planoSlug === undefined) return true;
  if (ajustes?.bloqueados?.includes(recurso)) return false;
  if (ajustes?.extras?.includes(recurso)) return true;
  return planoInclui(planoSlug, recurso);
}
