import { requireUser } from "@/lib/auth";
import { estadoAssinatura } from "@/lib/billing";
import { redirect } from "next/navigation";
import PushRegistration from "@/components/PushRegistration";
import { scalar } from "@/lib/db";
import { getSettings } from "@/lib/settings";
import { unreadCount } from "@/lib/notifications";
import { unreadCounters } from "@/lib/chat";
import { seedUnread } from "@/lib/chat-unread";
import { BottomNav, FloatingAction, Sidebar, TopBar } from "@/components/Shell";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  /*
   * Gate comercial (Etapa 3): assinatura expirada/suspensa/cancelada bloqueia
   * TODA a area autenticada. Falha ao consultar (ex.: banco indisponivel) NAO
   * bloqueia — o gate e fail-open por design, para nunca derrubar a operacao
   * por um erro transitorio da camada comercial.
   */
  const estado = await estadoAssinatura(user.company_id).catch(() => null);
  const bloqueado = estado?.bloqueioDuro === true;
  if (bloqueado && user.platform_admin === false) {
    return <AssinaturaBloqueada />;
  }

  // Os alertas sao recalculados no dashboard e na tela de notificacoes, e nao
  // aqui: rodar a varredura em toda navegacao deixava cada clique lento.
  const [settings, unread, chat] = await Promise.all([
    getSettings(),
    scalar<number>("SELECT COUNT(*) FROM user_notifications WHERE user_id=? AND read_at IS NULL", [user.id]),
    unreadCounters(user.id),
  ]);
  // Primeiro quadro: o contador ja nasce preenchido no servidor, sem piscar
  // de zero nem esperar a primeira consulta do ciclo compartilhado. A partir
  // daqui, apenas essa fonte alimenta topo, menu e tela do chat.
  seedUnread({
    unread: chat.unread,
    unreadConversations: chat.unreadConversations,
    conversations: [],
  });

  return (
    <div className="flex min-h-screen">
      <PushRegistration />
      <Sidebar company={settings.company_name} logo={settings.company_logo} />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar user={user} company={settings.company_name} logo={settings.company_logo} />
        <main className="com-barra-inferior mx-auto w-full max-w-6xl flex-1 p-3 sm:p-5">{children}</main>
      </div>
      <BottomNav />
      <FloatingAction />
      {estado?.avisoVencimento && <AvisoVencimento dias={estado.diasRestantes} />}
    </div>
  );
}

/** Redireciona a area bloqueada para a tela explicativa (fora do gate). */
function AssinaturaBloqueada(): never {
  redirect("/assinatura-bloqueada");
}

/** Banner fixo de vencimento proximo (5 dias) — servia de aviso antes do gate. */
function AvisoVencimento({ dias }: { dias: number | null }) {
  if (dias === null) return null;
  return (
    <div className="fixed bottom-16 left-1/2 z-40 -translate-x-1/2 rounded-full bg-amber-500 px-4 py-2 text-xs font-bold text-white shadow-lg sm:bottom-5">
      ⏳ Sua assinatura vence em {dias} dia{dias === 1 ? "" : "s"}. Renove em /faturamento.
    </div>
  );
}
