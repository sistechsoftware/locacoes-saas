"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Icon } from "./Icons";
import ChatBell from "./ChatBell";
import Avatar from "./Avatar";
import { EXTRA_NAV, MOBILE_NAV, NAV, NAV_GRUPOS, ACOES_AGRUPADO, ACOES_SHEET_AGRUPADO, comRotuloOperacoes, gruposParaPlano, itensParaPlano, visivelParaPlano, type AjustesMenu, type NavGroup, type NavLayout } from "@/lib/nav";
import { pokeUnread } from "@/lib/chat-unread";
import { useUnread } from "@/lib/use-unread";

type User = {
  id: number;
  name: string;
  role: string;
  avatar_url?: string | null;
  /** Operador da plataforma (dono do SaaS): libera o atalho para /saas. */
  platform_admin?: boolean;
};

const active = (pathname: string, href: string) =>
  pathname === href || (href !== "/dashboard" && pathname.startsWith(href));

/* --------------------------- barra lateral (desktop) --------------------------- */

/** Modo Classico: a lista plana de sempre, item apos item. */
function NavPlano({
  pathname,
  operacaoLabel,
  planoSlug,
  ajustes,
}: {
  pathname: string;
  operacaoLabel?: string;
  planoSlug?: string | null;
  ajustes?: AjustesMenu | null;
}) {
  return (
    <div className="space-y-0.5">
      {itensParaPlano(comRotuloOperacoes(NAV, operacaoLabel), planoSlug, ajustes).map((n) => (
        <Link
          key={n.href}
          href={n.href}
          className={`flex items-center gap-2.5 rounded-xl px-3 py-2.5 text-sm font-medium transition ${
            active(pathname, n.href)
              ? "bg-marca-600 text-white"
              : "text-tinta-700 hover:bg-nuvem-100"
          }`}
        >
          <Icon name={n.icon} className="h-[18px] w-[18px] shrink-0" />
          <span className="truncate">{n.label}</span>
        </Link>
      ))}
    </div>
  );
}

/** Modo Agrupado: mesmos destinos em grupos com subtitulo; grupos com um
 *  unico item nem exibem o rotulo (Dashboard fala por si). */
function NavGrupos({
  pathname,
  operacaoLabel,
  planoSlug,
  ajustes,
}: {
  pathname: string;
  operacaoLabel?: string;
  planoSlug?: string | null;
  ajustes?: AjustesMenu | null;
}) {
  return (
    <div className="space-y-1">
      {gruposParaPlano(NAV_GRUPOS, planoSlug, ajustes, operacaoLabel).map((g) => (
        <div key={g.titulo}>
          {g.itens.length > 1 && (
            <p className="px-3 pb-1 pt-3 text-[0.62rem] font-black uppercase tracking-widest text-stone-400">
              {g.titulo}
            </p>
          )}
          <div className="space-y-0.5">
            {g.itens.map((n) => (
              <Link
                key={n.href}
                href={n.href}
                className={`flex items-center gap-2.5 rounded-xl px-3 py-2 text-sm font-medium transition ${
                  active(pathname, n.href)
                    ? "bg-marca-600 text-white"
                    : "text-tinta-700 hover:bg-nuvem-100"
                }`}
              >
                <Icon name={n.icon} className="h-[18px] w-[18px] shrink-0" />
                <span className="truncate">{n.label}</span>
              </Link>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export function Sidebar({
  company,
  logo,
  operacaoLabel,
  planoSlug,
  ajustes,
  platformAdmin,
  layout = "classico",
}: {
  company: string;
  logo?: string;
  /** Nome das operações vindo da configuração da empresa (menu /operacao). */
  operacaoLabel?: string;
  /** Plano contratado: itens pagos fora do plano não aparecem (matriz em planos.ts). */
  planoSlug?: string | null;
  /** Personalizações da empresa (liberações/bloqueios/cortesia) — só apresentação. */
  ajustes?: AjustesMenu | null;
  /** Só o operador da plataforma (dono do SaaS) vê o atalho para /saas. */
  platformAdmin?: boolean;
  /** Layout de navegação da empresa (Configurações > Navegação). */
  layout?: NavLayout;
}) {
  const pathname = usePathname();
  // No desktop a lateral fica fixa (sticky) com a altura da viewport: quando os
  // itens nao cabem, somente a area de navegacao rola, sem arrastar a pagina
  // inteira. Abaixo de md nada muda — a barra segue oculta no celular.
  return (
    <aside className="nao-imprimir hidden w-60 shrink-0 flex-col border-r border-nuvem-300 bg-white md:flex md:h-screen md:sticky md:top-0">
      <Link href="/dashboard" className="flex items-center gap-2.5 border-b border-nuvem-200 px-4 py-4">
        {logo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={logo} alt="" className="h-9 w-9 rounded-lg object-contain" />
        ) : (
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-marca-600 text-lg font-black text-white">
            L
          </span>
        )}
        <span className="min-w-0">
          <span className="block truncate text-sm font-bold leading-tight text-tinta-900">{company}</span>
          <span className="block text-[0.68rem] uppercase tracking-wide text-stone-400">Gestão de Locações</span>
        </span>
      </Link>
      {/* min-h-0: dentro do flex, permite a navegacao encolher ate a altura
          disponivel — sem isso o overflow-y-auto nunca ativa. */}
      <nav className="navegacao-lateral min-h-0 flex-1 overflow-y-auto p-2">
        {layout === "agrupado" ? (
          <NavGrupos pathname={pathname} operacaoLabel={operacaoLabel} planoSlug={planoSlug} ajustes={ajustes} />
        ) : (
          <NavPlano pathname={pathname} operacaoLabel={operacaoLabel} planoSlug={planoSlug} ajustes={ajustes} />
        )}
      </nav>

      {/*
       * Assinatura do PRODUTO, separada do bloco acima. O topo da lateral e a
       * identidade do cliente (company_settings.company_name/logo); este rodape
       * e sempre o Locô, igual para todo tenant — a logo do cliente nunca
       * substitui a marca global do SaaS.
       */}
      {/* Atalho de VOLTA para o painel administrativo da plataforma — existe
          só para o operador do SaaS (quem tem users.platform_admin); o locador
          comum nunca vê este link e segue direto na operação. Espelho do botão
          "Ambiente operacional" que existe no SaasShell. */}
      {platformAdmin && (
        <div className="border-t border-nuvem-200 p-3">
          <Link
            href="/saas"
            className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-stone-600 hover:bg-nuvem-100"
            title="Abrir o painel administrativo da plataforma"
          >
            <Icon name="seta" className="h-3.5 w-3.5" /> Painel administrativo
          </Link>
        </div>
      )}
      <div className="flex items-center gap-2 border-t border-nuvem-200 px-4 py-3">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/icones/icone-512.png" alt="" className="h-7 w-7 shrink-0" />
        <span className="min-w-0">
          <span className="block text-[0.72rem] font-bold leading-tight text-tinta-800">Locô</span>
          <span className="block truncate text-[0.62rem] font-medium leading-tight text-stone-500">
            Gestão para locações
          </span>
        </span>
      </div>
    </aside>
  );
}

/* ------------------------------- barra superior ------------------------------- */

export function TopBar({
  user,
  company,
  logo,
  planoSlug,
  ajustes,
}: {
  user: User;
  company: string;
  logo?: string;
  /** Plano contratado: o chat é item pago (profissional+). */
  planoSlug?: string | null;
  /** Personalizações da empresa (liberações/bloqueios/cortesia) — só apresentação. */
  ajustes?: AjustesMenu | null;
}) {
  const [open, setOpen] = useState(false);
  // Mesma fonte do badge do menu inferior: o estado compartilhado do chat.
  const { unread } = useUnread();
  const chatLiberado = visivelParaPlano("/chat", planoSlug, ajustes);
  return (
    <header className="nao-imprimir sticky top-0 z-30 border-b border-nuvem-300 bg-white/95 backdrop-blur">
      <div className="flex items-center gap-2 px-3 py-2.5 sm:px-4">
        <Link href="/dashboard" className="flex shrink-0 items-center gap-2 md:hidden">
          {logo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={logo} alt="" className="h-8 w-8 rounded-lg object-contain" />
          ) : (
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-marca-600 text-base font-black text-white">
              L
            </span>
          )}
          <span className="max-w-[7.5rem] truncate text-sm font-bold text-tinta-900">{company}</span>
        </Link>

        <GlobalSearch />

        {/* Sino do chat: só existe para quem contratou Mensagens. */}
        {chatLiberado && <ChatBell />}

        <Link
          href="/notificacoes"
          aria-label="Notificações"
          className="relative shrink-0 rounded-xl p-2 text-tinta-700 hover:bg-nuvem-100"
        >
          <Icon name="sino" />
          {unread > 0 && chatLiberado && (
            <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-600 px-1 text-[0.6rem] font-bold text-white">
              {unread > 99 ? "99+" : unread}
            </span>
          )}
        </Link>

        <div className="relative shrink-0">
          <button
            onClick={() => setOpen((v) => !v)}
            className="flex h-9 w-9 items-center justify-center overflow-hidden rounded-full"
            aria-label="Menu do usuário"
          >
            <Avatar src={user.avatar_url} name={user.name} className="h-9 w-9 text-xs" bg="bg-marca-600 text-white" />
          </button>
          {open && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
              <div className="absolute right-0 z-20 mt-2 w-56 overflow-hidden rounded-xl border border-nuvem-300 bg-white shadow-lg">
                <div className="border-b border-nuvem-200 px-3 py-2.5">
                  <p className="text-sm font-bold text-tinta-900">{user.name}</p>
                  <p className="text-xs capitalize text-stone-500">{user.role}</p>
                </div>
                {/* Atalho para o painel /saas — SOMENTE platform_admin (dono
                    do sistema). Fica no menu do avatar porque ele é o único
                    ponto de navegação comum a celular e desktop. */}
                {user.platform_admin && (
                  <Link
                    href="/saas"
                    onClick={() => setOpen(false)}
                    className="flex items-center gap-2 px-3 py-2.5 text-sm hover:bg-nuvem-50"
                  >
                    <Icon name="seta" className="h-4 w-4" /> Painel administrativo
                  </Link>
                )}
                <Link
                  href="/configuracoes"
                  onClick={() => setOpen(false)}
                  className="flex items-center gap-2 px-3 py-2.5 text-sm hover:bg-nuvem-50"
                >
                  <Icon name="configuracoes" className="h-4 w-4" /> Configurações
                </Link>
                <form action="/api/logout" method="post">
                  <button className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm text-red-600 hover:bg-red-50">
                    <Icon name="saida" className="h-4 w-4" /> Sair
                  </button>
                </form>
              </div>
            </>
          )}
        </div>
      </div>
    </header>
  );
}

function GlobalSearch() {
  const router = useRouter();
  const [q, setQ] = useState("");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (q.trim()) router.push(`/busca?q=${encodeURIComponent(q.trim())}`);
      }}
      className="relative min-w-0 flex-1"
    >
      <Icon name="busca" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-stone-400" />
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Buscar cliente, telefone, número da reserva..."
        className="w-full rounded-xl border border-nuvem-300 bg-nuvem-50 py-2 pl-9 pr-3 text-sm outline-none focus:border-marca-400 focus:bg-white"
      />
    </form>
  );
}

/* ------------------------------ barra inferior -------------------------------- */

export function BottomNav({
  operacaoLabel,
  planoSlug,
  ajustes,
  layout = "classico",
}: {
  operacaoLabel?: string;
  /** Plano contratado: itens pagos (Mensagens, Fretes...) ficam fora do "Mais". */
  planoSlug?: string | null;
  /** Personalizações da empresa (liberações/bloqueios/cortesia) — só apresentação. */
  ajustes?: AjustesMenu | null;
  /** Layout de navegação da empresa (Configurações > Navegação). */
  layout?: NavLayout;
}) {
  const pathname = usePathname();
  const [sheet, setSheet] = useState(false);
  const chatLiberado = visivelParaPlano("/chat", planoSlug, ajustes);
  // Mesmo estado do sino do topo: uma unica fonte de verdade para o badge.
  // Mensagens saiu da barra, mas o contador continua visivel: o sino do topo,
  // o botao "Mais" (onde o chat agora vive) e o atalho no botao + leem tudo
  // daqui, entao nunca divergem.
  const { unread } = useUnread();

  useEffect(() => setSheet(false), [pathname]);

  // A barra inferior é invariantemente "4 itens + Mais": os 4 itens diretos
  // são recursos fundamentais (Dashboard, Agenda, Reservas, Operação) e nunca
  // caem por plano. O filtro de plano vale para os itens do menu "Mais".
  const extras = itensParaPlano(comRotuloOperacoes(EXTRA_NAV, operacaoLabel), planoSlug, ajustes);
  // "Mais" destacado quando o destino atual mora fora da barra: no classico
  // é qualquer item do sheet; no agrupado, os itens de grupo que nao estao
  // na barra (os 4 diretos nao contam).
  const noMais =
    layout === "classico"
      ? extras.some((n) => active(pathname, n.href))
      : gruposParaPlano(NAV_GRUPOS, planoSlug, ajustes, operacaoLabel).some((g) =>
          g.itens.some((n) => !MOBILE_NAV.some((m) => m.href === n.href) && active(pathname, n.href)),
        );

  return (
    <>
      {/* z-50: acima do botao flutuante + (z-40) — sem ele o + ficava
          desenhado por cima dos ladrilhos e roubava os toques. */}
      {sheet && (
        <div className="fixed inset-0 z-50 md:hidden" onClick={() => setSheet(false)}>
          <div className="absolute inset-0 bg-black/40" />
          <div
            className="absolute inset-x-0 bottom-0 max-h-[80vh] overflow-y-auto rounded-t-2xl bg-white p-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-nuvem-300" />
            {layout === "agrupado" ? (
              <MaisAgrupado
                pathname={pathname}
                operacaoLabel={operacaoLabel}
                planoSlug={planoSlug}
                ajustes={ajustes}
                chatLiberado={chatLiberado}
                unread={unread}
              />
            ) : (
              <div className="grid grid-cols-3 gap-2">
                {extras.map((n) => (
                  <Link
                    key={n.href}
                    href={n.href}
                    className={`flex flex-col items-center gap-1.5 rounded-xl border px-2 py-3 text-center text-[0.7rem] font-semibold ${
                      active(pathname, n.href)
                        ? "border-marca-200 bg-marca-50 text-marca-700"
                        : "border-nuvem-200 text-tinta-700"
                    }`}
                  >
                    <Icon name={n.icon} className="h-5 w-5 text-marca-600" />
                    <span className="leading-tight">{n.label}</span>
                  </Link>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Barra flutuante elevada: o nav cobre a base inteira com fundo opaco e
          respeita a area segura (env), e o cartao branco fica suspenso sempre
          ACIMA da Home Bar do iPhone — os glifos nunca caem na zona de gesto do
          iOS. Sem px fixo por aparelho: onde nao ha Home Bar o env() vale 0 e o
          cartao fica colado na base, como sempre foi no Android. */}
      <nav className="nao-imprimir fixed inset-x-0 bottom-0 z-30 bg-nuvem-100 pb-[env(safe-area-inset-bottom)] md:hidden">
        {/* Uma unica linha garantida: 4 itens + "Mais", cada um com 1/5 da
            largura — nunca quebra mesmo se MOBILE_NAV crescer (o slice
            protege o invariante). */}
        <div className="mx-2 mb-2 flex items-stretch rounded-2xl border border-nuvem-300 bg-white shadow-lg shadow-tinta-900/5">
          {comRotuloOperacoes(MOBILE_NAV, operacaoLabel).slice(0, 4).map((n) => {
            const isActive = active(pathname, n.href);
            return (
              <Link
                key={n.href}
                href={n.href}
                aria-current={isActive ? "page" : undefined}
                className="flex min-w-0 flex-1 flex-col items-center gap-1 py-2 text-[0.63rem] font-semibold outline-none"
              >
                {/* Capsula grande: junto do py-2 garante alvo de toque >= 48px
                    (minimo Apple/Google), com feedback imediato ao pressionar. */}
                <span
                  className={`flex h-8 w-full max-w-14 items-center justify-center rounded-full transition-colors ${
                    isActive ? "bg-marca-100 text-marca-700" : "text-stone-500 active:bg-nuvem-100"
                  }`}
                >
                  <Icon name={n.icon} className="h-[22px] w-[22px]" />
                </span>
                <span className={`leading-none transition-colors ${isActive ? "text-marca-700" : "text-stone-500"}`}>
                  {n.label.split(" ")[0]}
                </span>
              </Link>
            );
          })}
          <button
            onClick={() => setSheet(true)}
            aria-expanded={sheet}
            className="flex min-w-0 flex-1 flex-col items-center gap-1 py-2 text-[0.63rem] font-semibold outline-none"
          >
            <span
              className={`relative flex h-8 w-full max-w-14 items-center justify-center rounded-full transition-colors ${
                sheet || noMais ? "bg-marca-100 text-marca-700" : "text-stone-500 active:bg-nuvem-100"
              }`}
            >
              <Icon name="menu" className="h-[22px] w-[22px]" />
              {/* Mensagens mora no "Mais" agora: o contador de nao lidas
                  acompanhou — mas só existe para quem contratou o chat. */}
              {unread > 0 && chatLiberado && (
                <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-600 px-1 text-[0.58rem] font-bold leading-none text-white ring-2 ring-white">
                  {unread > 99 ? "99+" : unread}
                </span>
              )}
            </span>
            <span
              className={`leading-none transition-colors ${sheet || noMais ? "text-marca-700" : "text-stone-500"}`}
            >
              Mais
            </span>
          </button>
        </div>
      </nav>
    </>
  );
}

/** Sheet "Mais" no modo Agrupado: acoes rapidas no topo e grupos rotulados
 *  com os mesmos titulos da sidebar — a logica de organizacao e a mesma
 *  (gruposParaPlano aplica filtro de plano e rotulo da operacao), muda so a
 *  apresentacao. Itens diretos da barra inferior nao se repetem aqui. */
function MaisAgrupado({
  pathname,
  operacaoLabel,
  planoSlug,
  ajustes,
  chatLiberado,
  unread,
}: {
  pathname: string;
  operacaoLabel?: string;
  planoSlug?: string | null;
  ajustes?: AjustesMenu | null;
  chatLiberado: boolean;
  unread: number;
}) {
  const naBarra = new Set(MOBILE_NAV.map((n) => n.href));
  return (
    <div>
      <p className="mb-2 mt-1 text-[0.62rem] font-black uppercase tracking-widest text-stone-400">Ações rápidas</p>
      <div className="grid grid-cols-3 gap-2">
        {itensParaPlano(ACOES_SHEET_AGRUPADO, planoSlug, ajustes).map((a) => (
          <Link
            key={a.href}
            href={a.href}
            className="flex flex-col items-center gap-1.5 rounded-xl border border-marca-600 bg-marca-600 px-2 py-3 text-center text-[0.7rem] font-semibold text-white"
          >
            <Icon name={a.icon} className="h-5 w-5" />
            <span className="leading-tight">{a.label}</span>
          </Link>
        ))}
      </div>
      {gruposParaPlano(NAV_GRUPOS, planoSlug, ajustes, operacaoLabel).map((g: NavGroup) => {
        const itens = g.itens.filter((n) => !naBarra.has(n.href));
        if (itens.length === 0) return null;
        return (
          <div key={g.titulo}>
            <p className="mb-2 mt-4 text-[0.62rem] font-black uppercase tracking-widest text-stone-400">{g.titulo}</p>
            <div className="grid grid-cols-3 gap-2">
              {itens.map((n) => (
                <Link
                  key={n.href}
                  href={n.href}
                  className={`relative flex flex-col items-center gap-1.5 rounded-xl border px-2 py-3 text-center text-[0.7rem] font-semibold ${
                    active(pathname, n.href)
                      ? "border-marca-200 bg-marca-50 text-marca-700"
                      : "border-nuvem-200 text-tinta-700"
                  }`}
                >
                  <Icon name={n.icon} className="h-5 w-5 text-marca-600" />
                  <span className="leading-tight">{n.label}</span>
                  {n.href === "/chat" && unread > 0 && chatLiberado && (
                    <span className="absolute right-1.5 top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-600 px-1 text-[0.58rem] font-bold leading-none text-white">
                      {unread > 99 ? "99+" : unread}
                    </span>
                  )}
                </Link>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------ botao flutuante ------------------------------- */

const ACOES = [
  { href: "/chat", label: "Mensagens", icon: "chat" },
  { href: "/reservas/nova", label: "Nova Reserva", icon: "reservas" },
  { href: "/orcamentos/novo", label: "Novo Orçamento", icon: "orcamento" },
  { href: "/clientes/novo", label: "Novo Cliente", icon: "clientes" },
  { href: "/operacao/nova", label: "Nova Entrega", icon: "operacao" },
  { href: "/fretes/novo", label: "Novo Frete", icon: "fretes" },
  { href: "/compras/nova", label: "Nova Compra", icon: "estoque" },
  { href: "/fretes/calculadora", label: "Calcular Frete", icon: "financeiro" },
];export function FloatingAction({
  novaOperacaoLabel,
  planoSlug,
  ajustes,
  layout = "classico",
}: {
  novaOperacaoLabel?: string;
  /** Plano contratado: atalhos de recursos pagos (Mensagens, Fretes...) saem do +. */
  planoSlug?: string | null;
  /** Personalizações da empresa (liberações/bloqueios/cortesia) — só apresentação. */
  ajustes?: AjustesMenu | null;
  /** Layout de navegação da empresa (Configurações > Navegação). */
  layout?: NavLayout;
}) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  // Mesmo estado do sino do topo: badge de nao lidas do atalho Mensagens.
  const { unread } = useUnread();
  const chatLiberado = visivelParaPlano("/chat", planoSlug, ajustes);
  useEffect(() => setOpen(false), [pathname]);

  // No modo Agrupado o + perde o atalho Mensagens: conversa nao e criacao de
  // registro — o chat continua no sino do topo e no menu (Sistema).
  const acoes = layout === "agrupado" ? ACOES_AGRUPADO(ACOES) : ACOES;

  /* No chat a tela usa a altura inteira e o composer (anexo/mic/enviar) ocupa
     a base: o botao flutuante cobria o microfone e roubava toques. Fora do chat
     ele continua igual, com as mesmas acoes de sempre — agora incluindo
     Mensagens, que saiu da barra inferior e trocou de lugar com a Agenda. */
  if (pathname === "/chat") return null;

  return (
    <>
      {open && <div className="fixed inset-0 z-40 bg-black/30" onClick={() => setOpen(false)} />}
      {/* Acima da barra inferior (cartao + margem), em qualquer aparelho. */}
      <div className="nao-imprimir fixed bottom-28 right-4 z-40 flex flex-col items-end gap-2 md:bottom-6">
        {open &&
          itensParaPlano(acoes, planoSlug, ajustes).map((a) =>
            a.href === "/operacao/nova" && novaOperacaoLabel ? { ...a, label: novaOperacaoLabel } : a,
          ).map((a) => (
            <Link
              key={a.href}
              href={a.href}
              className="relative flex items-center gap-2 rounded-full bg-white py-2.5 pl-3 pr-4 text-sm font-semibold text-tinta-900 shadow-lg"
            >
              <Icon name={a.icon} className="h-4 w-4 text-marca-600" />
              {a.label}
              {a.href === "/chat" && unread > 0 && chatLiberado && (
                <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-600 px-1 text-[0.6rem] font-bold leading-none text-white">
                  {unread > 99 ? "99+" : unread}
                </span>
              )}
            </Link>
          ))}
        <button
          onClick={() => setOpen((v) => !v)}
          aria-label="Ações rápidas"
          className="relative flex h-14 w-14 items-center justify-center rounded-full bg-marca-500 text-tinta-900 shadow-xl transition hover:bg-marca-600 hover:text-white active:scale-95"
        >
          <Icon name={open ? "fechar" : "mais"} className="h-7 w-7" />
          {/* Ponto discreto de nao lidas: da pra saber sem abrir o menu. Vale
              so no Classico, onde o + tem o atalho Mensagens. */}
          {!open && layout === "classico" && unread > 0 && chatLiberado && (
            <span className="absolute right-1.5 top-1.5 h-2.5 w-2.5 rounded-full bg-red-500 ring-2 ring-white" />
          )}
        </button>
      </div>
    </>
  );
}
