import { apiUser } from "@/lib/api-security";
import { unreadCounters } from "@/lib/chat";

/**
 * Contador leve de mensagens nao lidas.
 *
 * O sino do topo e o badge do menu inferior precisam so de dois numeros e da
 * lista de conversas pendentes. A endpoint geral /api/chat devolve usuarios,
 * lista de conversas e contadores — peso desnecessario para um badge que
 * consulta a cada poucos segundos: a resposta fica pequena e o banco executa
 * uma unica consulta indexada em vez de quatro.
 *
 * GET /api/chat/unread -> { unread, unreadConversations, conversations[] }
 */
export async function GET(request: Request) {
  const user = await apiUser(request);
  if (!user) return Response.json({ error: "Sessão expirada." }, { status: 401 });
  const contadores = await unreadCounters(user.id, true);
  return Response.json(contadores, { headers: { "Cache-Control": "no-store" } });
}
