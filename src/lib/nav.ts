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
  { href: "/compras", label: "Compras", icon: "estoque" },
  { href: "/contratos", label: "Contratos", icon: "contratos" },
  { href: "/fretes", label: "Fretes", icon: "fretes" },
  { href: "/relatorios", label: "Relatórios", icon: "relatorios" },
  { href: "/historico", label: "Histórico", icon: "historico" },
  { href: "/erros", label: "Diário de erros", icon: "configuracoes", adminOnly: true },
  { href: "/configuracoes", label: "Configurações", icon: "configuracoes" },
];

/** Itens diretos da barra inferior. INVARIANTE: 4 itens + botao "Mais" = 5,
 *  exatamente uma linha em qualquer largura de celular (grid-cols-5 no Shell).
 *  Ordem pensada para o polegar: Dashboard, Agenda, Reservas, Entregas. */
export const MOBILE_NAV = NAV.filter((n) => n.mobile);

/** Menu "Mais" da barra inferior: tudo que nao cabe na barra, na ordem
 *  original do menu lateral (Mensagens primeiro) — sem duplicar entradas. */
export const EXTRA_NAV = NAV.filter((n) => !n.mobile);
