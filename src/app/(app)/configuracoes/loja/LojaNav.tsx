"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Subnavegação da seção Loja Virtual. É SÓ apresentação: cada rota tem o
 * próprio gate no servidor (requireModule + recurso loja_virtual).
 */
const SECOES = [
  { href: "/configuracoes/loja", label: "Visão geral" },
  { href: "/configuracoes/loja/personalizacao", label: "Personalização" },
  { href: "/configuracoes/loja/produtos", label: "Produtos publicados" },
  { href: "/configuracoes/loja/pedidos", label: "Pedidos recebidos" },
  { href: "/configuracoes/loja/comercial", label: "Configurações comerciais" },
  { href: "/configuracoes/loja/pix", label: "Pagamento por Pix" },
  { href: "/configuracoes/loja/publicacao", label: "Publicação e compartilhamento" },
];

export default function LojaNav() {
  const pathname = usePathname() ?? "";
  return (
    <nav className="scroll-x -mx-1 abas-barra px-1 sm:mx-0 sm:px-0">
      {SECOES.map((s) => {
        const ativo = s.href === "/configuracoes/loja" ? pathname === s.href : pathname.startsWith(s.href);
        return (
          <Link
            key={s.href}
            href={s.href}
            className={`whitespace-nowrap rounded-lg px-3 py-2 text-sm font-semibold ${
              ativo ? "bg-marca-600 text-white" : "text-stone-600 hover:bg-nuvem-100"
            }`}
          >
            {s.label}
          </Link>
        );
      })}
    </nav>
  );
}
