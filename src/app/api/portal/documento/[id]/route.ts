import { getFile } from "@/lib/uploads";
import { one } from "@/lib/db";
import { clienteAtual } from "@/lib/portal-auth";
import { respostaRecursoNaoContratado, temRecurso } from "@/lib/plano-gate";

/**
 * Download de documento do portal (contrato digitalizado, anexo da equipe).
 *
 * Seguranca: exige sessao do portal valida e o documento TEM que pertencer ao
 * cliente da sessao — a checagem e no backend, por customer_id, e nao na
 * ocultacao do botao. Sem sessao, 401; documento de outro cliente, 404.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const cliente = await clienteAtual();
  if (!cliente) return new Response("Não autenticado.", { status: 401 });
  // Recurso contratado: o Portal do Cliente é item pago (profissional+).
  // Sem o plano, o servidor nega ANTES de localizar o documento.
  if (!(await temRecurso({ company_id: cliente.company_id, platform_admin: false }, "portal"))) {
    return respostaRecursoNaoContratado("portal", cliente, "portal-api");
  }

  const { id } = await params;
  const docId = Number(id);
  if (!Number.isInteger(docId) || docId <= 0) return new Response("Not found", { status: 404 });

  const doc = await one<{ file_id: string | null; customer_id: number; source: string }>(
    `SELECT file_id, customer_id, source FROM customer_documents WHERE id = ?`,
    [docId],
  );
  if (!doc || doc.customer_id !== cliente.id || !doc.file_id) return new Response("Not found", { status: 404 });

  const file = await getFile(doc.file_id);
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
