import { notFound } from "next/navigation";
import { porToken, congelarCorpoAoAbrir } from "@/lib/assinatura-db";
import { impedimento, MENSAGEM_IMPEDIMENTO } from "@/lib/assinatura";
import { settingsDaEmpresa } from "@/lib/settings";
import { operacaoDaEmpresa } from "@/lib/operacao-db";
import { dateBR, dateTimeBR, money, nowLocal } from "@/lib/format";
import PainelAssinatura from "./PainelAssinatura";
import ContratoTexto from "@/components/ContratoTexto";
import CabecalhoContrato from "@/components/CabecalhoContrato";

export const dynamic = "force-dynamic";

/**
 * Pagina publica de assinatura.
 *
 * Fica fora do grupo autenticado de proposito: o cliente abre pelo link do
 * WhatsApp, sem cadastro, sem login e sem instalar nada. O unico segredo e o
 * token da URL, e nenhuma informacao de outro cliente e alcancavel daqui.
 */
export default async function AssinarPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const registroAberto = await porToken(token);
  if (!registroAberto) notFound();

  /**
   * Primeiro acesso do cliente define o corpo do contrato digital: e aqui que
   * o modelo digital e renderizado e congelado ({{data_assinatura_digital}}
   * entra com a data desta abertura). Acessos seguintes e a própria assinatura
   * leem esse texto congelado — a data não muda se o cliente voltar no dia
   * seguinte, e editar o modelo depois não altera o que ele leu.
   */
  const registro = await congelarCorpoAoAbrir(registroAberto);
  /*
   * Página pública sem sessão de empresa: as configurações são lidas pelo
   * company_id DO REGISTRO (assinatura da própria reserva). Sem este escopo,
   * o fallback de tenant devolveria as settings da empresa errada.
   */
  const s = await settingsDaEmpresa(registro.company_id);
  const operacao = await operacaoDaEmpresa(registro.company_id);
  const bloqueio = impedimento(registro, nowLocal());

  return (
    <main className="mx-auto min-h-dvh max-w-2xl bg-nuvem-50 px-4 py-6 sm:py-10">
      {/* Cabeçalho do contrato: logo (se cadastrada), nome, CNPJ/CPF,
          telefone e endereço — dados da empresa dona do registro, os mesmos
          que já abrem o corpo do contrato (LOCADORA). */}
      <CabecalhoContrato
        className="mb-4"
        nome={s.company_name}
        subtitulo={`Contrato de Locação ${registro.contract_number}`}
        logo={s.company_logo}
        doc={s.company_doc}
        telefone={s.company_phone}
        endereco={s.company_address}
        cidade={s.company_city}
      />

      <section className="cartao mb-4 p-4">
        <dl className="space-y-1 text-sm">
          <div className="flex justify-between gap-3">
            <dt className="text-stone-500">Cliente</dt>
            <dd className="text-right font-semibold text-tinta-900">{registro.customer_name}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-stone-500">Contrato</dt>
            <dd className="text-right font-semibold text-tinta-900">{registro.contract_number}</dd>
          </div>
          {/* rótulo/visibilidade conforme a configuração da empresa dona do
              contrato; o dado gravado permanece no documento */}
          {operacao.vis.evento && registro.event_date && (
            <div className="flex justify-between gap-3">
              <dt className="text-stone-500">{operacao.rotulos.evento}</dt>
              <dd className="text-right font-semibold text-tinta-900">{dateBR(registro.event_date)}</dd>
            </div>
          )}
          {operacao.vis.endereco && [registro.address, registro.district, registro.city].filter(Boolean).length > 0 && (
            <div className="flex justify-between gap-3">
              <dt className="text-stone-500">Local</dt>
              <dd className="text-right text-tinta-900">
                {[registro.address, registro.district, registro.city].filter(Boolean).join(", ")}
              </dd>
            </div>
          )}
          {registro.total_cents > 0 && (
            <div className="flex justify-between gap-3">
              <dt className="text-stone-500">Valor</dt>
              <dd className="text-right font-semibold text-tinta-900">{money(registro.total_cents)}</dd>
            </div>
          )}
        </dl>
      </section>

      <section className="cartao mb-4 p-4">
        <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-stone-500">Contrato</h2>
        <div className="max-h-[55vh] overflow-y-auto rounded-xl bg-white p-3">
          <ContratoTexto texto={registro.body_snapshot || registro.body} className="break-words text-sm leading-relaxed text-tinta-800" />
        </div>
      </section>

      {bloqueio ? (
        <section className="cartao p-4 text-center">
          <p className="text-sm font-semibold text-tinta-900">{MENSAGEM_IMPEDIMENTO[bloqueio]}</p>
          {bloqueio === "assinado" && registro.signed_at && (
            <p className="mt-1 text-sm text-stone-600">
              Assinado por {registro.signer_name} em {dateTimeBR(registro.signed_at)}.
            </p>
          )}
        </section>
      ) : (
        <PainelAssinatura token={token} nomeSugerido={registro.customer_name ?? ""} />
      )}

      <footer className="mt-6 text-center text-xs text-stone-500">
        {s.company_name}
        {s.company_phone ? ` · ${s.company_phone}` : ""}
      </footer>
    </main>
  );
}
