import Link from "next/link";
import { notFound } from "next/navigation";
import { one } from "@/lib/db";
import { requireCliente } from "@/lib/portal-auth";
import { documentoAssinado } from "@/lib/assinatura-db";
import { getCompanySignature } from "@/lib/assinatura-empresa";
import { settingsDaEmpresa } from "@/lib/settings";
import { rotaLogoPublica } from "@/lib/email-identidade";
import { dateTimeBR } from "@/lib/format";
import ContratoTexto from "@/components/ContratoTexto";
import CabecalhoContrato from "@/components/CabecalhoContrato";
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
  /*
   * Pagina servida com sessao de CLIENTE: a empresa dona do documento vem do
   * company_id da sessao. Sem este escopo, getSettings/getCompanySignature
   * cairiam no fallback de tenant e a assinatura exibida poderia ser a de
   * outra empresa. Mesmo criterio que a pagina publica /assinar/[token] usa.
   */
  const s = await settingsDaEmpresa(cliente.company_id);
  /**
   * Assinatura da empresa no documento que o cliente ve: entra somente quando
   * ela ja estava cadastrada no momento da assinatura (flag gravada em
   * assinar()). Assinaturas anteriores a este recurso continuam como eram.
   */
  const assinaturaEmpresa =
    doc.company_signature_included === 1 ? await getCompanySignature(cliente.company_id) : null;
  /** Mesmo arquivo congelado da tela interna; assinaturas antigas caem na atual. */
  const arquivoAssinaturaEmpresa = doc.company_signature_file_id ?? assinaturaEmpresa?.file_id ?? null;

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

        {doc.superseded_by_id && (
          <div className="rounded-2xl border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
            Este documento foi revogado e substituído
            {doc.substituido_por_numero ? ` pelo contrato ${doc.substituido_por_numero}` : ""}. Ele permanece aqui
            para consulta e auditoria; o contrato vigente é o substituto.
          </div>
        )}

        <PrintButton />

        <article className="cartao p-5 sm:p-6">
          {/* identidade da locadora acima do documento — mesmo cabeçalho
              do link de assinatura (logo, CNPJ, telefone, endereço) */}
          <CabecalhoContrato
            className="mb-4 border-b border-nuvem-200 pb-3"
            nome={s.company_name}
            subtitulo={`Contrato ${doc.contract_number}`}
            logo={rotaLogoPublica(s.company_logo)}
            doc={s.company_doc}
            telefone={s.company_phone}
            endereco={s.company_address}
            cidade={s.company_city}
          />

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
                  {arquivoAssinaturaEmpresa ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      // Rota do PORTAL: /api/arquivo/<id> exige sessao da
                      // equipe e respondia 401 para o cliente (imagem
                      // quebrada). Aqui a autorizacao e a sessao de cliente.
                      src={`/api/portal/arquivo/${arquivoAssinaturaEmpresa}`}
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
