"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Icon } from "./Icons";
import ChatBell from "./ChatBell";
import Avatar from "./Avatar";
import { EXTRA_NAV, MOBILE_NAV, NAV } from "@/lib/nav";
import { pokeUnread } from "@/lib/chat-unread";
import { useUnread } from "@/lib/use-unread";

type User = { id: number; name: string; role: string; avatar_url?: string | null };

const active = (pathname: string, href: string) =>
  pathname === href || (href !== "/dashboard" && pathname.startsWith(href));

/* --------------------------- barra lateral (desktop) --------------------------- */

export function Sidebar({ company, logo }: { company: string; logo?: string }) {
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
      <nav className="navegacao-lateral min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2">
        {NAV.map((n) => (
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
      </nav>
    </aside>
  );
}

/* ------------------------------- barra superior ------------------------------- */

export function TopBar({ user, company, logo }: { user: User; company: string; logo?: string }) {
  const [open, setOpen] = useState(false);
  // Mesma fonte do badge do menu inferior: o estado compartilhado do chat.
  const { unread } = useUnread();
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

        <ChatBell />

        <Link
          href="/notificacoes"
          aria-label="Notificações"
          className="relative shrink-0 rounded-xl p-2 text-tinta-700 hover:bg-nuvem-100"
        >
          <Icon name="sino" />
          {unread > 0 && (
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
        placeholder="Buscar cliente, LIMA-001, telefone..."
        className="w-full rounded-xl border border-nuvem-300 bg-nuvem-50 py-2 pl-9 pr-3 text-sm outline-none focus:border-marca-400 focus:bg-white"
      />
    </form>
  );
}

/* ------------------------------ barra inferior -------------------------------- */

export function BottomNav() {
  const pathname = usePathname();
  const [sheet, setSheet] = useState(false);
  // Mesmo estado do sino do topo: uma unica fonte de verdade para o badge.
  // Mensagens saiu da barra, mas o contador continua visivel: o sino do topo,
  // o botao "Mais" (onde o chat agora vive) e o atalho no botao + leem tudo
  // daqui, entao nunca divergem.
  const { unread } = useUnread();

  useEffect(() => setSheet(false), [pathname]);

  const noMais = EXTRA_NAV.some((n) => active(pathname, n.href));

  return (
    <>
      {/* z-50: acima do botao flutuante + (z-40) — sem ele o + ficava
          desenhado por cima dos ladrilhos e roubava os toques. */}
      {sheet && (
        <div className="fixed inset-0 z-50 md:hidden" onClick={() => setSheet(false)}>
          <div className="absolute inset-0 bg-black/40" />
          <div
            className="absolute inset-x-0 bottom-0 rounded-t-2xl bg-white p-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-nuvem-300" />
            <div className="grid grid-cols-3 gap-2">
              {EXTRA_NAV.map((n) => (
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
          {MOBILE_NAV.slice(0, 4).map((n) => {
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
                    isActive ? "bg-marca-100 text-marca-600" : "text-stone-500 active:bg-nuvem-100"
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
                sheet || noMais ? "bg-marca-100 text-marca-600" : "text-stone-500 active:bg-nuvem-100"
              }`}
            >
              <Icon name="menu" className="h-[22px] w-[22px]" />
              {/* Mensagens mora no "Mais" agora: o contador de nao lidas
                  acompanhou, no mesmo padrao de antes da barra. */}
              {unread > 0 && (
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
];

export function FloatingAction() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  // Mesmo estado do sino do topo: badge de nao lidas do atalho Mensagens.
  const { unread } = useUnread();
  useEffect(() => setOpen(false), [pathname]);

  /* No chat a tela usa a altura inteira e o composer (anexo/mic/enviar) ocupa a
     base: o botao flutuante cobria o microfone e roubava toques. Fora do chat
     ele continua igual, com as mesmas acoes de sempre — agora incluindo
     Mensagens, que saiu da barra inferior e trocou de lugar com a Agenda. */
  if (pathname === "/chat") return null;

  return (
    <>
      {open && <div className="fixed inset-0 z-40 bg-black/30" onClick={() => setOpen(false)} />}
      {/* Acima da barra inferior (cartao + margem), em qualquer aparelho. */}
      <div className="nao-imprimir fixed bottom-28 right-4 z-40 flex flex-col items-end gap-2 md:bottom-6">
        {open &&
          ACOES.map((a) => (
            <Link
              key={a.href}
              href={a.href}
              className="relative flex items-center gap-2 rounded-full bg-white py-2.5 pl-3 pr-4 text-sm font-semibold text-tinta-900 shadow-lg"
            >
              <Icon name={a.icon} className="h-4 w-4 text-marca-600" />
              {a.label}
              {a.href === "/chat" && unread > 0 && (
                <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-600 px-1 text-[0.6rem] font-bold leading-none text-white">
                  {unread > 99 ? "99+" : unread}
                </span>
              )}
            </Link>
          ))}
        <button
          onClick={() => setOpen((v) => !v)}
          aria-label="Ações rápidas"
          className="relative flex h-14 w-14 items-center justify-center rounded-full bg-marca-600 text-white shadow-xl transition active:scale-95"
        >
          <Icon name={open ? "fechar" : "mais"} className="h-7 w-7" />
          {/* Ponto discreto de nao lidas: da pra saber sem abrir o menu. */}
          {!open && unread > 0 && (
            <span className="absolute right-1.5 top-1.5 h-2.5 w-2.5 rounded-full bg-red-500 ring-2 ring-white" />
          )}
        </button>
      </div>
    </>
  );
}
