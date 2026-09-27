import { apiUser } from "@/lib/api-security";
import { isParticipant } from "@/lib/chat";
import { one } from "@/lib/db";
import { getFileById } from "@/lib/uploads";

/**
 * Serve anexo/audio do chat com autorizacao.
 *
 * Diferente de /api/arquivo/<id> (publico por design para logos e fotos de
 * produtos), um arquivo de chat so e entregue a quem participa da conversa
 * onde a mensagem que o referencia foi enviada. Trocar o id na URL nao ajuda:
 * ids aleatorios de 32 hexa, e o vinculo mensagem->conversa decide o acesso.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await apiUser(request);
  if (!user) return new Response("Sessão expirada.", { status: 401 });
  const { id } = await params;
  if (!/^[0-9a-f]{32}$/.test(id)) return new Response("Not found", { status: 404 });

  const vinculo = await one<{ conversation_id: number }>(
    `SELECT conversation_id FROM chat_messages WHERE file_id = ? AND deleted_at IS NULL LIMIT 1`,
    [id],
  );
  if (!vinculo) return new Response("Not found", { status: 404 });
  if (!(await isParticipant(vinculo.conversation_id, user.id))) {
    return new Response("Sem permissão.", { status: 403 });
  }

  const file = await getFileById(id);
  if (!file) return new Response("Not found", { status: 404 });

  const corpo = file.data.buffer.slice(
    file.data.byteOffset,
    file.data.byteOffset + file.data.byteLength,
  ) as ArrayBuffer;

  const url = new URL(request.url);
  const download = url.searchParams.get("download") === "1";
  const nome = url.searchParams.get("nome") ?? "";
  const ascii = nome.replace(/[^\x20-\x7E]/g, "_").replace(/"/g, "");

  return new Response(corpo, {
    headers: {
      "Content-Type": file.mime,
      "Content-Length": String(corpo.byteLength),
      "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${ascii || "arquivo"}"; filename*=UTF-8''${encodeURIComponent(nome || "arquivo")}`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    },
  });
}
