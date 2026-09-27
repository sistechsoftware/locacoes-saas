import { getFile } from "@/lib/uploads";
import { one } from "@/lib/db";
import { clienteAtual } from "@/lib/portal-auth";

const HEX32 = /^[0-9a-f]{32}$/;

/**
 * Arquivo do portal (imagem da assinatura digital).
 *
 * O /api/arquivo/<id> publico continua existindo para logo, fotos de produto e
 * anexos internos. Aqui a regra e outra: so abre o arquivo se ele estiver
 * vinculado a um documento ou a uma assinatura DO cliente da sessao. Sem
 * sessao, 401; arquivo de outro cliente, 404. Cache privado: nenhum proxy
 * guarda um documento de cliente.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const cliente = await clienteAtual();
  if (!cliente) return new Response("Não autenticado.", { status: 401 });

  const { id } = await params;
  if (!HEX32.test(id)) return new Response("Not found", { status: 404 });

  // autorizacao: o arquivo precisa pertencer ao cliente logado, seja pela
  // assinatura digital (signature_file_id) seja por um documento anexado
  const donoAssinatura = await one<{ id: number }>(
    `SELECT id FROM contract_signatures WHERE signature_file_id = ? AND customer_id = ?`,
    [id, cliente.id],
  );
  const viaDocumento = await one<{ customer_id: number; file_id: string | null }>(
    `SELECT customer_id, file_id FROM customer_documents WHERE file_id = ?`,
    [id],
  );
  const autorizado = !!donoAssinatura || (!!viaDocumento && viaDocumento.customer_id === cliente.id && !!viaDocumento.file_id);
  if (!autorizado) return new Response("Not found", { status: 404 });

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
      "Content-Disposition": "inline",
      "Cache-Control": "private, no-store",
    },
  });
}
