import { requireUser } from "@/lib/auth";
import { contactableUsers, listConversations, unreadCounters } from "@/lib/chat";
import { seedUnread } from "@/lib/chat-unread";
import ChatApp from "./ChatApp";

export const dynamic = "force-dynamic";

/**
 * Tela do chat. O servidor entrega so o primeiro quadro (lista de conversas,
 * contatos e contadores); tudo depois e incrementado pelo polling da API,
 * sem recarregar a pagina. Os contadores vem de unreadCounters — a mesma
 * fonte do sino do topo e do badge do menu inferior.
 */
export default async function ChatPage() {
  const user = await requireUser();
  const [users, conversations, contadores] = await Promise.all([
    contactableUsers(user.id),
    listConversations(user.id),
    unreadCounters(user.id, true),
  ]);
  // Semeia o estado compartilhado com os detalhes por conversa (o ChatApp
  // consume para nao refazer contas nem consultar de novo ao montar).
  seedUnread(contadores);
  return (
    <ChatApp me={{ id: user.id, name: user.name, role: user.role, avatar_url: user.avatar_url }} initialUsers={users} initialConversations={conversations} />
  );
}
