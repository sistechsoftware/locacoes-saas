import Link from "next/link";
import { notFound } from "next/navigation";
import { one } from "@/lib/db";
import { requireCliente } from "@/lib/portal-auth";
import { documentoAssinado } from "@/lib/assinatura-db";
import { getCompanySignature } from "@/lib/assinatura-empresa";
import { getSettings } from "@/lib/settings";
import { dateTimeBR } from "@/lib/format";
import ContratoTexto from "@/components/ContratoTexto";
import PrintButton from "@/app/(app)/contratos/[id]/PrintButton";

export const dynamic = "force-dynamic";

/**
 * Versao assinada (congelada) do contrato digital, vista pelo cliente.
 *
 * O id da assinatura vem da URL; a AUTORIZACAO vem da sessao — a consulta
 * abaixo so devolve o documento quando a assinatura pertence ao cliente
 * logado. Id de outro cliente vira 404.
 */
export default async function PortalContratoAssinadoPage({ params }: { params: Promise<{ id: string }> }) {
  const cliente = await requireCliente();
  const { id } = await params;
  const assinaturaId = Number(id);
  if (!Number.isInteger(assinaturaId) || assinaturaId <= 0) notFound();

  const dono = await one<{ customer_id: number }>(
    `SELECT customer_id FROM contract_signatures WHERE id = ? AND status = 'assinado'`,
    [assinaturaId],
  );
  if (!dono || dono.customer_id !== cliente.id) notFound();

  const doc = await documentoAssinado(assinaturaId);
  if (!doc) notFound();
  const s = await getSettings();
  /**
   * Assinatura da empresa no documento que o cliente ve: entra somente quando
   * ela ja estava cadastrada no momento da assinatura (flag gravada em
   * assinar()). Assinaturas anteriores a este recurso continuam como eram.
   */
  const assinaturaEmpresa = doc.company_signature_included === 1 ? await getCompanySignature() : null;

  return (
    <div className="space-y-4">
      <Link href="/portal/contratos" className="inline-flex items-center gap-1 text-sm font-semibold text-marca-600">
        ← Voltar para meus contratos
      </Link>

      <div className="space-y-3">
        <div className="rounded-2xl border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          ✅ Contrato assinado digitalmente por <b>{doc.signer_name}</b> em {dateTimeBR(doc.signed_at)}. Este é o texto
          exato que foi lido e aceito — impressões feitas a partir daqui valem como via do contrato.
        </div>

        <PrintButton />

        <article className="cartao p-5 sm:p-6">
          <ContratoTexto texto={doc.body_snapshot} className="break-words text-sm leading-relaxed text-tinta-800" />

          <section className="mt-8 border-t border-nuvem-200 pt-4">
            {doc.company_signature_included === 1 ? (
              <div className="flex flex-wrap items-end justify-between gap-6">
                <div className="text-center">
                  <p className="mb-2 text-xs font-semibold uppercase text-stone-500">Assinatura do Contratante</p>
                  {doc.signature_file_id && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={`/api/portal/arquivo/${doc.signature_file_id}`}
                      alt={`Assinatura de ${doc.signer_name}`}
                      className="h-24 max-w-[240px] object-contain"
                    />
                  )}
                  <p className="mt-1 border-t border-tinta-900 pt-1 text-sm font-semibold text-tinta-900">
                    {doc.signer_name}
                  </p>
                </div>
                <div className="text-center">
                  <p className="mb-2 text-xs font-semibold uppercase text-stone-500">Assinatura da Locadora</p>
                  {assinaturaEmpresa ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={assinaturaEmpresa.url}
                      alt="Assinatura da empresa"
                      className="h-24 max-w-[240px] object-contain"
                    />
                  ) : (
                    <div className="h-24 w-[240px]" />
                  )}
                  <p className="mt-1 border-t border-tinta-900 pt-1 text-sm font-semibold text-tinta-900">
                    {s.company_name}
                  </p>
                </div>
              </div>
            ) : (
              <>
                <p className="mb-2 text-xs font-semibold uppercase text-stone-500">Assinatura do Contratante</p>
                {doc.signature_file_id && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={`/api/portal/arquivo/${doc.signature_file_id}`}
                    alt={`Assinatura de ${doc.signer_name}`}
                    className="h-24 max-w-full object-contain"
                  />
                )}
                <p className="mt-1 border-t border-tinta-900 pt-1 text-sm font-semibold text-tinta-900">
                  {doc.signer_name}
                </p>
              </>
            )}
          </section>
        </article>
      </div>
    </div>
  );
}
