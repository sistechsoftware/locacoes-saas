"use client";

import Link from "next/link";
import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { holdUnreadPolling, pokeUnread, releaseUnreadPolling } from "@/lib/chat-unread";
import { useUnread } from "@/lib/use-unread";

/**
 * Sino do chat: contador de mensagens nao lidas.
 *
 * Nao consulta mais nada por conta própria: le do estado compartilhado
 * (chat-unread), que tambem alimenta o badge do menu inferior e a tela do
 * chat — topo e menu nunca divergem. O ciclo de consultas e unico para a
 * pagina inteira, com endpoint leve e ritmo adaptativo (rapido apos navegar,
 * lento em tela parada, pausado em aba oculta).
 */
export default function ChatBell() {
  const pathname = usePathname();
  const { unread } = useUnread();

  // Uma participacao por montagem; o ciclo compartilhado vive enquanto houver
  // quem leia (sino, menu inferior ou tela do chat) e para quando a pagina sai.
  useEffect(() => {
    holdUnreadPolling();
    return () => releaseUnreadPolling();
  }, []);

  // Troca de rota: consulta imediata e ritmo rapido por um ciclo.
  useEffect(() => {
    pokeUnread();
  }, [pathname]);

  if (pathname === "/chat") return null;

  return (
    <Link
      href="/chat"
      aria-label="Mensagens"
      className="relative shrink-0 rounded-xl p-2 text-tinta-700 hover:bg-nuvem-100"
    >
      <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5" aria-hidden="true">
        <path
          d="M12 3C7.03 3 3 6.58 3 11c0 2.1.9 4.02 2.38 5.47-.16 1.2-.62 2.4-1.53 3.28a.5.5 0 0 0 .37.86c1.92-.06 3.6-.72 4.9-1.55.92.28 1.88.44 2.88.44 4.97 0 9-3.58 9-8.5S16.97 3 12 3Z"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      {!!unread && unread > 0 && (
        <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-emerald-600 px-1 text-[0.6rem] font-bold text-white">
          {unread > 99 ? "99+" : unread}
        </span>
      )}
    </Link>
  );
}
