"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { Icon } from "./Icons";
import Avatar from "./Avatar";
import { MOBILE_SAAS_NAV, SAAS_NAV } from "@/lib/nav";

type User = { id: number; name: string; username: string; avatar_url?: string | null };

const active = (pathname: string, href: string) =>
  pathname === href || (href !== "/saas" && pathname.startsWith(`${href}/`));

/**
 * Shell do ambiente administrativo — INDEPENDENTE do Shell operacional.
 * Nenhuma funcionalidade de locação (reservas, estoque, agenda) existe aqui:
 * a navegação inteira vem de SAAS_NAV/MOBILE_SAAS_NAV.
 */
export function SaasShell({
  user,
  plataforma,
  children,
}: {
  user: User;
  plataforma: string;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [menuMobile, setMenuMobile] = useState(false);

  const sidebar = (
    <aside className="nao-imprimir hidden w-60 shrink-0 flex-col border-r border-stone-200 bg-tinta-900 md:flex md:h-screen md:sticky md:top-0">
      <Link href="/saas" className="flex items-center gap-2.5 border-b border-white/10 px-4 py-4">
        <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-600 text-lg font-black text-white">
          S
        </span>
        <span className="min-w-0">
          <span className="block truncate text-sm font-bold leading-tight text-white">Central SaaS</span>
          <span className="block text-[0.68rem] uppercase tracking-wide text-stone-400">{plataforma}</span>
        </span>
      </Link>
      <nav className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2">
        {SAAS_NAV.map((n) => (
          <Link
            key={n.href}
            href={n.href}
            className={`flex items-center gap-2.5 rounded-xl px-3 py-2.5 text-sm font-medium transition ${
              active(pathname, n.href) ? "bg-emerald-600 text-white" : "text-stone-300 hover:bg-white/10"
            }`}
          >
            <Icon name={n.icon} className="h-[18px] w-[18px] shrink-0" />
            <span className="truncate">{n.label}</span>
          </Link>
        ))}
      </nav>
      <div className="border-t border-white/10 p-3">
        <Link
          href="/dashboard"
          className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-stone-400 hover:bg-white/10"
          title="Abrir o ambiente operacional (da sua empresa vinculada)"
        >
          <Icon name="seta" className="h-3.5 w-3.5" /> Ambiente operacional
        </Link>
      </div>
    </aside>
  );

  return (
    <div className="flex min-h-screen bg-stone-100">
      {sidebar}

      {/* Barra superior (desktop + mobile) */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="nao-imprimir sticky top-0 z-30 border-b border-stone-200 bg-white/95 backdrop-blur">
          <div className="flex items-center gap-2 px-3 py-2.5 sm:px-4">
            <button
              className="rounded-xl p-2 text-tinta-700 hover:bg-stone-100 md:hidden"
              onClick={() => setMenuMobile((v) => !v)}
              aria-label="Menu administrativo"
            >
              <Icon name={menuMobile ? "fechar" : "menu"} />
            </button>
            <Link href="/saas" className="flex items-center gap-2 md:hidden">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-600 text-base font-black text-white">
                S
              </span>
              <span className="text-sm font-bold text-tinta-900">Central SaaS</span>
            </Link>
            <span className="hidden min-w-0 flex-1 truncate text-sm font-bold text-tinta-900 md:block">
              Administração da plataforma
            </span>
            <div className="relative shrink-0">
              <button
                onClick={() => setOpen((v) => !v)}
                className="flex h-9 w-9 items-center justify-center overflow-hidden rounded-full"
                aria-label="Menu do usuário"
              >
                <Avatar src={user.avatar_url} name={user.name} className="h-9 w-9 text-xs" bg="bg-emerald-600 text-white" />
              </button>
              {open && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
                  <div className="absolute right-0 z-20 mt-2 w-56 overflow-hidden rounded-xl border border-stone-200 bg-white shadow-lg">
                    <div className="border-b border-stone-200 px-3 py-2.5">
                      <p className="text-sm font-bold text-tinta-900">{user.name}</p>
                      <p className="text-xs text-emerald-700">Administrador da plataforma</p>
                    </div>
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
          {/* Navegação mobile desdobrada (menu hambúrguer) */}
          {menuMobile && (
            <nav className="border-t border-stone-200 bg-white px-2 py-2 md:hidden">
              {MOBILE_SAAS_NAV.map((n) => (
                <Link
                  key={n.href}
                  href={n.href}
                  onClick={() => setMenuMobile(false)}
                  className={`flex items-center gap-2.5 rounded-xl px-3 py-2.5 text-sm font-medium ${
                    active(pathname, n.href) ? "bg-emerald-600 text-white" : "text-tinta-700 hover:bg-stone-100"
                  }`}
                >
                  <Icon name={n.icon} className="h-[18px] w-[18px]" />
                  {n.label}
                </Link>
              ))}
            </nav>
          )}
        </header>

        <main className="mx-auto w-full max-w-6xl flex-1 p-3 sm:p-5">{children}</main>
      </div>
    </div>
  );
}
