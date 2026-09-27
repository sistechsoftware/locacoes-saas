import { apiUser, rateLimit } from "@/lib/api-security";
import { ChatError, conversationsSnapshot, contactableUsers, listMessages, markRead, sendMessage, stateSince, unreadCounters, deleteMessage } from "@/lib/chat";
import { UploadError } from "@/lib/uploads";

/**
 * API do chat.
 *
 * GET  /api/chat                      -> nao lidas + usuarios + conversas (sino e lista)
 * GET  /api/chat?c=<id>&after=<id>    -> mensagens novas + cursores (polling de 3s)
 * GET  /api/chat?c=<id>&before=<id>   -> pagina anterior do historico
 * POST /api/chat                      -> envia texto/audio/arquivos (multipart)
 * PATCH /api/chat                     -> marca lida / arquiva / reativa
 * DELETE /api/chat?id=<msg>           -> exclusao logica da mensagem (remetente)
 */
export async function GET(request: Request) {
  const user = await apiUser(request);
  if (!user) return Response.json({ error: "Sessão expirada." }, { status: 401 });
  const url = new URL(request.url);
  const c = Number(url.searchParams.get("c")) || 0;

  try {
    if (!c) {
      const [users, snapshot, contadores] = await Promise.all([
        contactableUsers(user.id),
        conversationsSnapshot(user.id),
        unreadCounters(user.id, true),
      ]);
      return Response.json(
        {
          users,
          conversations: snapshot.conversations,
          unread: contadores.unread,
          unreadConversations: contadores.unreadConversations,
          unreadPorConversa: contadores.conversations,
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    const after = Number(url.searchParams.get("after")) || 0;
    const before = Number(url.searchParams.get("before")) || 0;
    if (after) {
      const st = await stateSince(user.id, c, after);
      return Response.json({ ...st, incremental: true }, { headers: { "Cache-Control": "no-store" } });
    }
    const page = await listMessages(user.id, c, before, 40);
    return Response.json(
      { messages: page.messages, other: page.other, incremental: false },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    if (e instanceof ChatError) return Response.json({ error: e.message }, { status: 404 });
    return Response.json({ error: "Falha ao carregar o chat." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const user = await apiUser(request, true);
  if (!user) return Response.json({ error: "Sessão expirada ou origem inválida." }, { status: 401 });
  try {
    if (!(await rateLimit(`chat:${user.id}`, 60))) {
      return Response.json({ error: "Muitas mensagens seguidas. Aguarde um instante." }, { status: 429 });
    }
    const form = await request.formData();
    const body = String(form.get("body") ?? "");
    const conversationId = Number(form.get("c")) || undefined;
    const otherUserId = Number(form.get("para")) || undefined;
    const audio = form.get("audio");
    const audioSeconds = Number(form.get("audio_seconds")) || null;
    const clientDurationMs = Number(form.get("duration_ms")) || null;
    const files = form.getAll("files").filter((f): f is File => f instanceof File);

    const criadas = await sendMessage(user, {
      conversationId,
      otherUserId,
      body,
      audio: audio instanceof File && audio.size > 0 ? audio : null,
      audioSeconds,
      clientDurationMs,
      files,
    });
    return Response.json({ ok: true, messages: criadas });
  } catch (e) {
    if (e instanceof UploadError) return Response.json({ error: e.message }, { status: 400 });
    if (e instanceof ChatError) return Response.json({ error: e.message }, { status: 400 });
    return Response.json({ error: "Falha ao enviar a mensagem. Tente novamente." }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  const user = await apiUser(request, true);
  if (!user) return Response.json({ error: "Sessão expirada ou origem inválida." }, { status: 401 });
  try {
    const input = (await request.json()) as { action?: string; c?: number; arquivar?: boolean };
    const c = Number(input.c);
    if (!c) throw new ChatError("Conversa inexistente.");
    if (input.action === "lida") {
      await markRead(user.id, c);
      // A leitura muda o contador: o PATCH responde com a mesma fonte usada
      // pelo sino do topo e pelo menu inferior, e o cliente semeia na hora —
      // sem esperar o proximo ciclo de polling.
      const contadores = await unreadCounters(user.id, true);
      return Response.json({ ok: true, ...contadores });
    }
    if (input.action === "arquivar") {
      const { archiveConversation } = await import("@/lib/chat");
      await archiveConversation(user.id, c, !!input.arquivar);
      return Response.json({ ok: true });
    }
    throw new ChatError("Ação inválida.");
  } catch (e) {
    if (e instanceof ChatError) return Response.json({ error: e.message }, { status: 400 });
    return Response.json({ error: "Falha na operação." }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  const user = await apiUser(request, true);
  if (!user) return Response.json({ error: "Sessão expirada ou origem inválida." }, { status: 401 });
  try {
    const id = Number(new URL(request.url).searchParams.get("id"));
    await deleteMessage(user.id, id);
    return Response.json({ ok: true });
  } catch (e) {
    if (e instanceof ChatError) return Response.json({ error: e.message }, { status: 400 });
    return Response.json({ error: "Falha ao excluir." }, { status: 500 });
  }
}
