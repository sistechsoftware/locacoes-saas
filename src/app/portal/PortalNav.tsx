"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const ITENS = [
  { href: "/portal", label: "Início" },
  { href: "/portal/historico", label: "Locações" },
  { href: "/portal/contratos", label: "Contratos" },
];

/** Navegacao inferior do portal, mobile-first, formato de abas. */
export default function PortalNav() {
  const pathname = usePathname();
  return (
    <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-nuvem-200 bg-white/95 backdrop-blur">
      <div className="mx-auto grid max-w-3xl grid-cols-3">
        {ITENS.map((i) => {
          const ativo = i.href === "/portal" ? pathname === "/portal" : pathname.startsWith(i.href);
          return (
            <Link
              key={i.href}
              href={i.href}
              className={`flex flex-col items-center gap-0.5 py-2.5 text-[0.7rem] font-semibold transition ${
                ativo ? "text-marca-600" : "text-stone-500"
              }`}
            >
              <span
                className={`h-1 w-6 rounded-full transition ${ativo ? "bg-marca-600" : "bg-transparent"}`}
                aria-hidden
              />
              {i.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
