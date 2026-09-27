import Link from "next/link";
import { requireCliente } from "@/lib/portal-auth";
import { contratosDoCliente, documentosDoPortal } from "@/lib/portal";
import { dateBR, dateTimeBR } from "@/lib/format";

export const dynamic = "force-dynamic";

/**
 * Contratos e documentos do cliente.
 *
 * Distingue, com a mesma fonte de verdade do sistema interno:
 * - DIGITAL: existe contract_signatures com status 'assinado' — o documento
 *   congelado e a assinatura sao os que ja existem, vistos pela pagina
 *   /portal/contratos/assinado/[id] (mesmo conteudo da tela interna).
 * - MANUEIS / digitalizados: customer_documents com source 'upload_manual',
 *   servidos por /api/portal/documento/[id], que confere a propriedade.
 * Nada e duplicado: sao os mesmos registros e os mesmos arquivos.
 */
export default async function PortalContratos() {
  const cliente = await requireCliente();
  const [contratos, documentos] = await Promise.all([
    contratosDoCliente(cliente.id),
    documentosDoPortal(cliente.id),
  ]);

  const digitais = contratos.filter((c) => c.assinatura_status === "assinado");
  const outros = contratos.filter((c) => c.assinatura_status !== "assinado");
  const avulsos = documentos.filter((d) => d.source === "upload_manual");

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-xl font-black text-tinta-900">Meus contratos</h1>
        <p className="text-sm text-stone-500">
          {contratos.length} contrato(s) · {digitais.length} assinado(s) digitalmente
          {avulsos.length ? ` · ${avulsos.length} documento(s) anexado(s)` : ""}
        </p>
      </header>

      <section>
        <h2 className="mb-2 text-xs font-bold uppercase tracking-wide text-emerald-700">
          ✍️ Assinados digitalmente ({digitais.length})
        </h2>
        {digitais.length === 0 ? (
          <p className="rounded-xl border border-dashed border-nuvem-300 bg-nuvem-50 px-4 py-6 text-center text-sm text-stone-500">
            Nenhum contrato assinado digitalmente ainda.
          </p>
        ) : (
          <div className="space-y-2">
            {digitais.map((c) => (
              <Link
                key={c.id}
                href={`/portal/contratos/assinado/${c.assinatura_id}`}
                className="block cartao p-3.5 transition hover:border-marca-300"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-tinta-900">Contrato {c.number}</p>
                    <p className="mt-0.5 text-xs text-stone-500">
                      Reserva {c.reservation_number}
                      {c.event_date ? ` · evento ${dateBR(c.event_date)}` : ""}
                    </p>
                    <p className="text-xs text-emerald-700">
                      Assinado por {c.signer_name} em {c.assinatura_signed_at ? dateTimeBR(c.assinatura_signed_at) : "—"}
                    </p>
                  </div>
                  <span className="shrink-0 rounded-full border border-emerald-300 bg-emerald-50 px-2 py-1 text-xs font-bold text-emerald-700">
                    Assinado
                  </span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>

      {outros.length > 0 && (
        <section>
          <h2 className="mb-2 text-xs font-bold uppercase tracking-wide text-stone-500">
            Outros contratos ({outros.length})
          </h2>
          <div className="space-y-2">
            {outros.map((c) => {
              const manual = c.status === "assinado" && c.assinatura_status !== "assinado";
              return (
                <div key={c.id} className="cartao p-3.5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-bold text-tinta-900">Contrato {c.number}</p>
                      <p className="mt-0.5 text-xs text-stone-500">
                        Reserva {c.reservation_number}
                        {c.event_date ? ` · evento ${dateBR(c.event_date)}` : ""}
                      </p>
                      {manual && c.signed_at && (
                        <p className="text-xs text-stone-500">Assinado em {dateBR(c.signed_at)}</p>
                      )}
                      <p className="text-xs text-stone-500">{SITUACAO[c.status] ?? c.status}</p>
                    </div>
                    <span className={`shrink-0 rounded-full border px-2 py-1 text-xs font-bold ${BORDA[c.status] ?? BORDA._padrao}`}>
                      {ROTULO[c.status] ?? c.status}
                    </span>
                  </div>
                  {manual && (
                    <p className="mt-2 rounded-xl bg-nuvem-50 px-3 py-2 text-xs text-stone-600">
                      📄 Contrato assinado no papel. A via digitalizada aparece em “Documentos anexados” abaixo, quando
                      disponível.
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}

      <section>
        <h2 className="mb-2 text-xs font-bold uppercase tracking-wide text-stone-500">
          Documentos anexados ({avulsos.length})
        </h2>
        {avulsos.length === 0 ? (
          <p className="rounded-xl border border-dashed border-nuvem-300 bg-nuvem-50 px-4 py-6 text-center text-sm text-stone-500">
            Nenhum documento digitalizado anexado pela equipe.
          </p>
        ) : (
          <div className="space-y-2">
            {avulsos.map((d) => (
              <div key={d.id} className="cartao flex items-center justify-between gap-3 p-3.5">
                <div className="min-w-0">
                  <p className="truncate text-sm font-bold text-tinta-900">{d.title}</p>
                  <p className="text-xs text-stone-500">
                    {dateBR(d.created_at)}
                    {d.contract_number ? ` · contrato ${d.contract_number}` : ""}
                    {d.reservation_number ? ` · reserva ${d.reservation_number}` : ""}
                    {d.size ? ` · ${(d.size / 1024).toFixed(0)} KB` : ""}
                  </p>
                </div>
                <a
                  href={`/api/portal/documento/${d.id}`}
                  target="_blank"
                  rel="noreferrer"
                  className="shrink-0 rounded-xl border border-nuvem-300 bg-white px-3 py-2 text-xs font-bold text-marca-600"
                >
                  Abrir
                </a>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

const ROTULO: Record<string, string> = {
  pendente: "Aguardando assinatura",
  enviado: "Enviado para assinatura",
  assinado: "Assinado",
  encerrado: "Encerrado",
  cancelado: "Cancelado",
};

const BORDA: Record<string, string> = {
  pendente: "bg-amber-50 text-amber-800 border-amber-300",
  enviado: "bg-sky-50 text-sky-800 border-sky-300",
  assinado: "bg-emerald-50 text-emerald-800 border-emerald-300",
  encerrado: "bg-stone-100 text-stone-700 border-stone-300",
  cancelado: "bg-red-50 text-red-800 border-red-300",
  _padrao: "bg-stone-100 text-stone-700 border-stone-300",
};

const SITUACAO = ROTULO;
