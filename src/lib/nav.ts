import { visivelParaPlano, type AjustesMenu } from "./planos";

// Reexportado para os componentes do menu filtrarem sem importar planos.ts.
export { visivelParaPlano };
export type { AjustesMenu };

/** Definicao unica do menu, usada pela barra lateral e pela barra inferior. */
export type NavItem = {
  href: string;
  label: string;
  icon: string;
  adminOnly?: boolean;
  /** Aparece na barra inferior do celular */
  mobile?: boolean;
};

export const NAV: NavItem[] = [
  /* Barra inferior (mobile): no maximo 4 itens aqui — o quinto espaco e sempre
     o botao "Mais". Ver MOBILE_NAV/EXTRA_NAV abaixo. Mensagens ficou de fora
     da barra de proposito: o chat tem tela propria de altura inteira, o sino
     do topo ja mostra o contador e o botao flutuante + ganhou o atalho
     "Mensagens" — a barra fica com a operacao do dia (Agenda, Reservas e
     Entregas/Retiradas) mais o Dashboard. */
  { href: "/dashboard", label: "Dashboard", icon: "dashboard", mobile: true },
  { href: "/chat", label: "Mensagens", icon: "chat" },
  { href: "/agenda", label: "Agenda", icon: "agenda", mobile: true },
  { href: "/reservas", label: "Reservas", icon: "reservas", mobile: true },
  { href: "/operacao", label: "Entregas e Retiradas", icon: "operacao", mobile: true },
  { href: "/orcamentos", label: "Orçamentos", icon: "orcamento" },
  { href: "/clientes", label: "Clientes", icon: "clientes" },
  { href: "/estoque", label: "Estoque", icon: "estoque" },
  { href: "/disponibilidade", label: "Disponibilidade", icon: "disponibilidade" },
  { href: "/promocoes", label: "Promoções", icon: "estoque" },
  { href: "/fidelidade", label: "Fidelidade", icon: "clientes" },
  { href: "/aniversarios", label: "Aniversariantes", icon: "agenda" },
  { href: "/financeiro", label: "Financeiro", icon: "financeiro" },
  { href: "/faturamento", label: "Assinatura", icon: "assinatura" },
  { href: "/compras", label: "Compras", icon: "estoque" },
  { href: "/contratos", label: "Contratos", icon: "contratos" },
  { href: "/fretes", label: "Fretes", icon: "fretes" },
  { href: "/relatorios", label: "Relatórios", icon: "relatorios" },
  { href: "/historico", label: "Histórico", icon: "historico" },
  { href: "/suporte", label: "Suporte", icon: "suporte" },
  { href: "/erros", label: "Diário de erros", icon: "configuracoes", adminOnly: true },
  { href: "/configuracoes", label: "Configurações", icon: "configuracoes" },
];

/** Itens diretos da barra inferior. INVARIANTE: 4 itens + botao "Mais" = 5,
 *  exatamente uma linha em qualquer largura de celular (grid-cols-5 no Shell).
 *  Ordem pensada para o polegar: Dashboard, Agenda, Reservas, Entregas. */
export const MOBILE_NAV = NAV.filter((n) => n.mobile);

/* ------------------------------------------------------------------ */
/* Navegação do AMBIENTE ADMINISTRATIVO (/saas)                         */
/* ------------------------------------------------------------------ */
/* Completamente separada da operacional: nada de reservas/estoque/agenda.
 * O guard de acesso é server-side (layout do grupo (saas)); isto aqui é só
 * apresentação. Ícones existentes em Icons.tsx. */
export const SAAS_NAV = [
  { href: "/saas", label: "Dashboard", icon: "dashboard" },
  { href: "/saas/empresas", label: "Empresas", icon: "clientes" },
  { href: "/saas/assinaturas", label: "Assinaturas", icon: "contratos" },
  { href: "/saas/cobrancas", label: "Cobranças", icon: "financeiro" },
  { href: "/saas/eventos", label: "Eventos Asaas", icon: "historico" },
  { href: "/saas/suporte", label: "Suporte", icon: "suporte" },
  { href: "/saas/atividade", label: "Atividade", icon: "sino" },
  { href: "/saas/configuracoes", label: "Integrações", icon: "configuracoes" },
] as const;

/** Versão resumida para o menu hambúrguer mobile do shell SaaS. */
export const MOBILE_SAAS_NAV: { href: string; label: string; icon: string }[] = [
  { href: "/saas", label: "Dashboard", icon: "dashboard" },
  ...SAAS_NAV.filter((n) => n.href !== "/saas"),
];

/** Menu "Mais" da barra inferior: tudo que nao cabe na barra, na ordem
 *  original do menu lateral (Mensagens primeiro) — sem duplicar entradas. */
export const EXTRA_NAV = NAV.filter((n) => !n.mobile);

/**
 * Filtra itens de menu/atalho pelo plano CONTRATADO da empresa
 * (correção de planos — a matriz mora em planos.ts).
 *
 * `planoSlug`:
 *  * string   — filtra pela matriz comercial (itens pagos fora do plano saem);
 *  * null     — plano desconhecido: so itens fundamentais ficam de pe;
 *  * undefined— sem restricao (operador da plataforma).
 *
 * `ajustes` opcional aplica as personalizações da empresa (liberações e
 * bloqueios administrativos, cortesia vigente) — mesmo filtro efetivo que o
 * gate do backend aplica nas portas.
 *
 * Isto é SÓ apresentação: a porta de verdade continua fechada no backend
 * (requireModule/requireModuleEdit/apiUser) — esconder o menu não é o gate.
 */
export function itensParaPlano<T extends { href: string }>(
  itens: readonly T[],
  planoSlug: string | null | undefined,
  ajustes?: AjustesMenu | null,
): T[] {
  return itens.filter((n) => visivelParaPlano(n.href, planoSlug, ajustes));
}

/**
 * Aplica o nome das operações da empresa ao item de menu /operacao.
 *
 * Fonte única: o label do menu NÃO é texto fixo — vem da configuração
 * operacional (tituloOperacoes), passada pelo layout autenticado. Sem o
 * rótulo (ou em telas sem configuração), o item mantém o texto legado
 * "Entregas e Retiradas".
 */
export function comRotuloOperacoes<T extends { href: string; label: string }>(
  itens: readonly T[],
  label?: string,
): T[] {
  if (!label) return itens as T[];
  return itens.map((n) => (n.href === "/operacao" ? { ...n, label } : n));
}

/* ==================== MODO AGRUPADO (opcional) ==================== */

/** Layout de navegacao escolhido pela empresa (Configuracoes > Navegacao).
 *  "classico" e o padrao: menu plano de sempre, byte a byte. "agrupado"
 *  organiza os mesmos destinos em grupos conceituais — nenhuma rota muda. */
export type NavLayout = "classico" | "agrupado";

/**
 * Normaliza o valor vindo do formulario/ banco.
 *
 * Unica fonte da regra: so "agrupado" liga o modo agrupado; qualquer outro
 * valor (lixo, chave antiga, vazio) cai no classico — comportamento atual do
 * SaaS preservado para empresas existentes. Pura e sem sessao: a action de
 * salvar e os testes usam a MESMA funcao.
 */
export function resolverNavLayout(valor: unknown): NavLayout {
  return valor === "agrupado" ? "agrupado" : "classico";
}

/** Grupo de navegacao do modo Agrupado (desktop e mobile compartilham). */
export type NavGroup = { titulo: string; itens: NavItem[] };

/**
 * Mesmos destinos do NAV, agora em grupos. A pergunta que organiza: "onde eu
 * procuraria?" — operacao do dia em Operacao, quem contrata em Comercial, o
 * que alugamos em Estoque, dinheiro/controle em Gestao (inclui a assinatura
 * do SaaS, em /faturamento) e ajustes/comunicacao interna em Sistema. Cada
 * href do NAV aparece EXATAMENTE uma vez aqui (travado em teste): nenhum
 * destino novo e nenhum destino some no modo agrupado.
 */
export const NAV_GRUPOS: NavGroup[] = [
  { titulo: "Início", itens: [{ href: "/dashboard", label: "Dashboard", icon: "dashboard" }] },
  {
    titulo: "Operação",
    itens: [
      { href: "/agenda", label: "Agenda", icon: "agenda" },
      { href: "/orcamentos", label: "Orçamentos", icon: "orcamento" },
      { href: "/reservas", label: "Reservas", icon: "reservas" },
      { href: "/operacao", label: "Entregas e Retiradas", icon: "operacao" },
      { href: "/fretes", label: "Fretes", icon: "fretes" },
    ],
  },
  {
    titulo: "Comercial",
    itens: [
      { href: "/clientes", label: "Clientes", icon: "clientes" },
      { href: "/contratos", label: "Contratos", icon: "contratos" },
      { href: "/promocoes", label: "Promoções", icon: "estoque" },
      { href: "/fidelidade", label: "Fidelidade", icon: "clientes" },
      { href: "/aniversarios", label: "Aniversariantes", icon: "agenda" },
    ],
  },
  {
    titulo: "Estoque",
    itens: [
      { href: "/estoque", label: "Estoque", icon: "estoque" },
      { href: "/disponibilidade", label: "Disponibilidade", icon: "disponibilidade" },
      { href: "/compras", label: "Compras", icon: "estoque" },
    ],
  },
  {
    titulo: "Gestão",
    itens: [
      { href: "/financeiro", label: "Financeiro", icon: "financeiro" },
      { href: "/faturamento", label: "Assinatura", icon: "assinatura" },
      { href: "/relatorios", label: "Relatórios", icon: "relatorios" },
      { href: "/historico", label: "Histórico", icon: "historico" },
    ],
  },
  {
    titulo: "Sistema",
    itens: [
      { href: "/configuracoes", label: "Configurações", icon: "configuracoes" },
      { href: "/suporte", label: "Suporte", icon: "suporte" },
      { href: "/chat", label: "Mensagens", icon: "chat" },
      { href: "/erros", label: "Diário de erros", icon: "configuracoes", adminOnly: true },
    ],
  },
];

/**
 * Grupos já aplicados ao SaaS: rótulo da operação + filtro de plano
 * (mesmos filtros do modo classico — a organização em grupos nunca muda
 * quem pode ver o quê). Grupos que ficaram vazios saem, como na referência.
 */
export function gruposParaPlano(
  grupos: NavGroup[],
  planoSlug: string | null | undefined,
  ajustes?: AjustesMenu | null,
  operacaoLabel?: string,
): NavGroup[] {
  return grupos
    .map((g) => ({ ...g, itens: comRotuloOperacoes(itensParaPlano(g.itens, planoSlug, ajustes), operacaoLabel) }))
    .filter((g) => g.itens.length > 0);
}

/** Acao rapida do botao flutuante +. */
export type AcaoRapida = { href: string; label: string; icon: string };

/** Botao + no modo Agrupado: sem "Mensagens" — conversa nao e criacao de
 *  registro. O chat segue acessivel pelo sino do topo e pelo menu. */
export const ACOES_AGRUPADO = (acoes: readonly AcaoRapida[]): AcaoRapida[] =>
  acoes.filter((a) => a.href !== "/chat");

/** Acoes rapidas do topo do sheet "Mais" no modo Agrupado (mobile): as
 *  criacoes mais comuns do dia a dia, uma tela a menos de distancia. */
export const ACOES_SHEET_AGRUPADO: AcaoRapida[] = [
  { href: "/reservas/nova", label: "+ Reserva", icon: "reservas" },
  { href: "/orcamentos/novo", label: "+ Orçamento", icon: "orcamento" },
  { href: "/clientes/novo", label: "+ Cliente", icon: "clientes" },
];
