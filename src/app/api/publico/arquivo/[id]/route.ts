import { getFile } from "@/lib/uploads";
import { one } from "@/lib/db";

const HEX32 = /^[0-9a-f]{32}$/;

/**
 * Rota PÚBLICA de arquivo — mecanismo explícito e escopo definido.
 *
 * O antigo /api/arquivo/[id] público virou protegido (mesma URL, agora com
 * sessão). O que é genuinamente público continua existindo APENAS aqui:
 * a logo da empresa, exibida na tela de login e no portal — páginas que
 * ninguém acessa autenticado.
 *
 * Como arquivo público, o cache forte é seguro: o id é aleatório de 32 hex e
 * o conteúdo de uma logo nunca muda.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!HEX32.test(id)) return new Response("Not found", { status: 404 });

  // Público SÓ se a logo de alguma empresa aponta para este arquivo.
  const ehLogo = await one<{ n: number }>(
    `SELECT 1 AS n FROM company_settings
      WHERE key = 'company_logo' AND value IN (?, ?)`,
    [`/api/arquivo/${id}`, `/api/publico/arquivo/${id}`],
  );
  if (!ehLogo) return new Response("Not found", { status: 404 });

  const file = await getFile(id);
  if (!file) return new Response("Not found", { status: 404 });

  const corpo = file.data.buffer.slice(
    file.data.byteOffset,
    file.data.byteOffset + file.data.byteLength,
  ) as ArrayBuffer;

  return new Response(corpo, {
    headers: {
      "Content-Type": file.mime,
      "Content-Length": String(corpo.byteLength),
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}
