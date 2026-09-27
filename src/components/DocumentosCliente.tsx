import Link from "next/link";
import { dateBR, dateTimeBR } from "@/lib/format";
import { Badge, Empty, Section } from "@/components/ui";
import { SubmitButton } from "@/components/SubmitButton";
import { adicionarDocumento, removerDocumento } from "@/app/(app)/clientes/actions";

/**
 * Historico de contratos e documentos do cliente.
 *
 * Cada documento e um registro proprio e nenhum substitui o anterior: um
 * cliente acumula contratos ao longo dos anos, e todos precisam continuar
 * acessiveis. O que foi assinado virtualmente e distinguido do que foi
 * anexado a mao, porque a rastreabilidade dos dois nao e a mesma.
 */
export function DocumentosCliente({
  customerId,
  documentos,
  admin,
}: {
  customerId: number;
  documentos: any[];
  admin: boolean;
}) {
  return (
    <Section title={`Contratos e Documentos (${documentos.length})`}>
      {documentos.length === 0 ? (
        <Empty>Nenhum documento ainda. Assine um contrato pelo link ou anexe um arquivo abaixo.</Empty>
      ) : (
        <ul className="divide-y divide-nuvem-200">
          {documentos.map((d) => {
            const virtual = d.source === "assinatura_virtual";
            return (
              <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-1.5 text-sm font-semibold text-tinta-900">
                    <span className="truncate">{d.title}</span>
                    {virtual ? (
                      <Badge tone="verde">assinado virtualmente</Badge>
                    ) : (
                      <Badge tone="cinza">enviado manualmente</Badge>
                    )}
                  </p>
                  <p className="text-xs text-stone-500">
                    {virtual && d.signed_at
                      ? `${d.signer_name} · ${dateTimeBR(d.signed_at)}`
                      : dateBR(d.created_at)}
                    {d.contract_number ? ` · contrato ${d.contract_number}` : ""}
                    {d.size ? ` · ${(d.size / 1024).toFixed(0)} KB` : ""}
                  </p>
                  {d.notes && <p className="text-xs text-stone-500">{d.notes}</p>}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {virtual && d.signature_id ? (
                    <Link
                      href={`/contratos/assinado/${d.signature_id}`}
                      className="rounded-lg border border-nuvem-300 bg-white px-2.5 py-1.5 text-xs font-semibold"
                    >
                      Visualizar
                    </Link>
                  ) : (
                    d.file_id && (
                      <a
                        href={`/api/arquivo/${d.file_id}`}
                        target="_blank"
                        rel="noreferrer"
                        className="rounded-lg border border-nuvem-300 bg-white px-2.5 py-1.5 text-xs font-semibold"
                      >
                        Abrir
                      </a>
                    )
                  )}
                  {admin && !virtual && (
                    <form action={removerDocumento}>
                      <input type="hidden" name="id" value={d.id} />
                      <SubmitButton
                        variant="perigo"
                        confirm={`Remover "${d.title}"?`}
                        className="px-2.5 py-1.5 text-xs"
                      >
                        Remover
                      </SubmitButton>
                    </form>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <form action={adicionarDocumento} className="mt-3 grid gap-2 rounded-xl bg-nuvem-100 p-3 sm:grid-cols-2">
        <input type="hidden" name="customer_id" value={customerId} />
        <label className="block sm:col-span-2">
          <span className="rotulo">Adicionar Documento</span>
          <input
            type="file"
            name="file"
            accept="application/pdf,image/jpeg,image/png"
            required
            className="w-full text-sm"
          />
        </label>
        <input name="title" placeholder="Título (opcional)" maxLength={160} className="campo" />
        <input name="notes" placeholder="Observação (opcional)" maxLength={300} className="campo" />
        <div className="sm:col-span-2">
          <SubmitButton>Enviar Documento</SubmitButton>
          <p className="mt-1 text-xs text-stone-500">
            PDF, JPG ou PNG, até 5 MB. Use para contratos assinados no papel e documentos antigos.
          </p>
        </div>
      </form>
    </Section>
  );
}
