import { apiUser } from "@/lib/api-security";
import { podeVerAnexoSuporte } from "@/lib/suporte";
import { getFileById } from "@/lib/uploads";

/**
 * Serve anexo de chamado de suporte com autorização.
 *
 * Mesmo desenho de /api/chat/arquivo/<id>: a rota pública /api/arquivo não
 * serve este conteúdo. O acesso exige sessão válida (apiUser — que já aplica
 * gate de assinatura e de recurso) e o vínculo mensagem -> chamado: a empresa
 * só enxerga anexos do PRÓPRIO chamado; a plataforma (platform_admin), de
 * qualquer um. Trocar o id na URL não resolve: ids são aleatórios de 32 hexa
 * e o vínculo decide o acesso.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  if (!user) return new Response("Sessão expirada.", { status: 401 });
  const { id } = await params;
  if (!/^[0-9a-f]{32}$/.test(id)) return new Response("Not found", { status: 404 });

  if (!(await podeVerAnexoSuporte(id, user))) {
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
