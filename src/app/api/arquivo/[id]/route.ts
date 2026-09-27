import { getFile } from "@/lib/uploads";

/** Serve as imagens guardadas no D1. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f]{32}$/.test(id)) return new Response("Not found", { status: 404 });

  const file = await getFile(id);
  if (!file) return new Response("Not found", { status: 404 });

  // BodyInit aceita ArrayBuffer; o slice garante um buffer proprio e exato
  const corpo = file.data.buffer.slice(
    file.data.byteOffset,
    file.data.byteOffset + file.data.byteLength,
  ) as ArrayBuffer;

  return new Response(corpo, {
    headers: {
      "Content-Type": file.mime,
      "Content-Length": String(corpo.byteLength),
      // o id e aleatorio e o conteudo nunca muda, entao pode cachear forte
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}
