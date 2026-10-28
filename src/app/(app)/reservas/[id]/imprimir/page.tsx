import { notFound } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import { companyContext, requireModule } from "@/lib/auth";
import { getSettings } from "@/lib/settings";
import { getOperacao } from "@/lib/operacao-db";
import { rotuloOu, statusReserva } from "@/lib/operacao";
import { getReservation, reservationItems } from "@/lib/reservations";
import { adiantamentoPrevisto, saldoContratualPrevisto } from "@/lib/receber";
import { RESERVATION_STATUS, statusLabel } from "@/lib/domain";
import { dateBR, dateUtcBR, docBR, money, phoneBR, timeBR } from "@/lib/format";
import { rotuloDesconto } from "@/lib/desconto";
import { rotuloExtensao } from "@/lib/hora-extra";
import PrintButton from "@/app/(app)/contratos/[id]/PrintButton";

export const dynamic = "force-dynamic";

/**
 * Impressão da reserva (ou salvamento em PDF pelo dialogo do navegador).
 *
 * Mesmo mecanismo, layout e CSS dos orcamentos (.imprimivel/.nao-imprimir,
 * PrintButton com window.print, @page de 16mm): a identidade visual do
 * documento e identica, so muda o que e exclusivo da reserva (numero, status,
 * adiantamento/restante previstos).
 *
 * Todo leitura nasce escopada pelo company_id do contexto autenticado — uma
 * reserva de outra empresa e inexistente aqui (mesmo IDOR fechado na tela de
 * detalhe), inclusive no titulo usado como nome do arquivo em PDF.
 */
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  /* O titulo vaza dados se a consulta nao for escopada: sem contexto de empresa
     (fora de request / sessao expirada) devolve o titulo generico. */
  const ctx = await companyContext();
  const r = ctx ? await getReservation(Number(id), ctx.companyId) : null;
  if (!r) return { title: "Reserva" };
  return { title: `Reserva-${sanitizar(r.number)}-${sanitizar(r.customer_name)}` };
}

/** Tira acentos e simbolos que atrapalham o nome do arquivo. */
function sanitizar(texto: string | null | undefined): string {
  return (texto ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export default async function ReservaImprimirPage({ params }: { params: Promise<{ id: string }> }) {
  // mesma permissao da tela da reserva: sem sessao nao ha documento
  const ctx = await requireModule("reservas");
  const { id } = await params;
  // reserva de outra empresa responde 404 (isolamento por empresa)
  const r = await getReservation(Number(id), ctx.companyId);
  if (!r) notFound();

  const [itens, s, operacao, adiantamento] = await Promise.all([
    reservationItems(r.id, ctx.companyId),
    getSettings(),
    getOperacao(),
    // condicao comercial prevista da MESMA fonte do contrato
    // ({{adiantamento_valor}}): nenhuma conta paralela aqui
    adiantamentoPrevisto(r.id, ctx.companyId),
  ]);
  const STATUS_RESERVA = statusReserva(operacao, RESERVATION_STATUS);

  const enderecoEmpresa = [s.company_address, s.company_city].filter(Boolean).join(" - ");
  const enderecoCliente = [r.customer_district, r.customer_city].filter(Boolean).join(", ");
  const enderecoEvento = [r.address, r.district, r.city].filter(Boolean).join(", ");
  const contatoEmpresa = [phoneBR(s.company_phone), s.company_email].filter(Boolean).join(" - ");

  // linhas de servico so aparecem quando tem valor
  const servicos = [
    {
      rotulo: `Frete (${operacao.rotulos.operacao_inicio.toLowerCase()} e ${operacao.rotulos.operacao_fim.toLowerCase()})`,
      valor: r.freight_cents,
    },
    { rotulo: "Montagem", valor: r.assembly_cents },
    { rotulo: "Desmontagem", valor: r.disassembly_cents },
    { rotulo: "Outros serviços", valor: r.other_cents },
    { rotulo: `Extensão de retirada ${rotuloExtensao(r.extension_minutes)}`, valor: r.extension_cents },
  ].filter((l) => l.valor > 0);

  const temDesconto = r.discount_cents > 0;
  const subtotal = r.items_cents + servicos.reduce((soma, l) => soma + l.valor, 0);
  // restante previsto = total contratado − adiantamento previsto (a mesma
  // regra de {{valor_saldo}} no contrato, ver saldoContratualPrevisto)
  const restante = saldoContratualPrevisto(r.total_cents, adiantamento);

  const servicosContratados = [
    r.needs_delivery && operacao.rotulos.operacao_inicio.toLowerCase(),
    r.needs_pickup && operacao.rotulos.operacao_fim.toLowerCase(),
    r.needs_assembly && "montagem",
    r.needs_disassembly && "desmontagem",
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="nao-imprimir flex flex-wrap items-center justify-between gap-2">
        <Link href={`/reservas/${r.id}`} className="text-sm font-semibold text-marca-600">
          Voltar à Reserva
        </Link>
        <PrintButton />
      </div>

      <article className="cartao imprimivel bg-white p-6 text-tinta-900 sm:p-10">
        {/* cabecalho */}
        <header className="flex flex-wrap items-start justify-between gap-4 border-b-2 border-marca-600 pb-4">
          <div className="flex items-center gap-3">
            {s.company_logo ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={s.company_logo} alt="" className="h-16 w-16 rounded-xl object-contain" />
            ) : null}
            <div>
              <p className="text-lg font-black leading-tight text-marca-600">{s.company_name}</p>
              {s.company_doc && <p className="text-xs text-stone-600">CNPJ/CPF: {docBR(s.company_doc)}</p>}
              {contatoEmpresa && <p className="text-xs text-stone-600">{contatoEmpresa}</p>}
              {enderecoEmpresa && <p className="text-xs text-stone-600">{enderecoEmpresa}</p>}
            </div>
          </div>
          <div className="text-right">
            <p className="text-xs font-bold uppercase tracking-wide text-stone-500">Reserva</p>
            <p className="text-xl font-black text-marca-600">{r.number}</p>
            <p className="text-xs text-stone-600">Emitido em {dateUtcBR(r.created_at)}</p>
            <p className="text-xs text-stone-600">Status: {statusLabel(STATUS_RESERVA, r.status)}</p>
          </div>
        </header>

        {/* cliente */}
        <section className="mt-5">
          <h2 className="mb-1.5 text-xs font-bold uppercase tracking-wide text-marca-600">Cliente</h2>
          <div className="rounded-lg bg-nuvem-100 px-3 py-2.5 text-sm">
            <p className="font-bold">{r.customer_name}</p>
            {r.customer_doc && <p className="text-stone-700">CPF/CNPJ: {docBR(r.customer_doc)}</p>}
            {r.customer_phone && <p className="text-stone-700">Telefone: {phoneBR(r.customer_phone)}</p>}
            {r.customer_whatsapp && r.customer_whatsapp !== r.customer_phone && (
              <p className="text-stone-700">WhatsApp: {phoneBR(r.customer_whatsapp)}</p>
            )}
            {r.customer_email && <p className="text-stone-700">E-mail: {r.customer_email}</p>}
            {enderecoCliente && <p className="text-stone-700">Endereço: {enderecoCliente}</p>}
          </div>
        </section>

        {/* evento / locacao */}
        {(r.event_date || enderecoEvento || r.delivery_at || r.pickup_at) && (
          <section className="mt-4">
            <h2 className="mb-1.5 text-xs font-bold uppercase tracking-wide text-marca-600">
              {operacao.vis.evento ? "Evento" : "Locação"}
            </h2>
            <div className="rounded-lg bg-nuvem-100 px-3 py-2.5 text-sm text-stone-700">
              {operacao.vis.evento && r.event_date && (
                <p>
                  {operacao.rotulos.evento}: <b className="text-tinta-900">{dateBR(r.event_date)}</b>
                  {r.event_time ? ` às ${r.event_time}` : ""}
                </p>
              )}
              {r.delivery_at && (
                <p>
                  {rotuloOu(operacao, "inicio", "Entrega prevista")}: {dateBR(r.delivery_at)} {timeBR(r.delivery_at)}
                </p>
              )}
              {r.pickup_at && (
                <p>
                  {rotuloOu(operacao, "fim", "Retirada prevista")}: {dateBR(r.pickup_at)} {timeBR(r.pickup_at)}
                </p>
              )}
              {operacao.vis.endereco && enderecoEvento && <p>Local: {enderecoEvento}</p>}
              {servicosContratados && <p>Serviços: {servicosContratados}</p>}
            </div>
          </section>
        )}

        {/* itens */}
        <section className="mt-5">
          <h2 className="mb-1.5 text-xs font-bold uppercase tracking-wide text-marca-600">Itens</h2>
          <div className="scroll-x">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="bg-marca-600 text-white">
                  <th className="px-2 py-2 text-left font-semibold">Descrição</th>
                  <th className="w-16 px-2 py-2 text-right font-semibold">Qtd</th>
                  <th className="w-28 px-2 py-2 text-right font-semibold">Valor un.</th>
                  <th className="w-28 px-2 py-2 text-right font-semibold">Subtotal</th>
                </tr>
              </thead>
              <tbody>
                {itens.map((i: any) => (
                  <tr key={i.id} className="border-b border-nuvem-200">
                    <td className="px-2 py-2">
                      {i.product_name}
                      {i.pricing_mode === "diaria" && i.period_qty > 1 ? ` · ${i.period_qty} diárias` : ""}
                      {i.discount_cents > 0 ? ` · desconto ${rotuloDesconto(i.discount_cents, i.discount_expr)}` : ""}
                    </td>
                    <td className="px-2 py-2 text-right">{i.qty}</td>
                    <td className="px-2 py-2 text-right">{money(i.unit_price_cents)}</td>
                    <td className="px-2 py-2 text-right font-semibold">{money(i.subtotal_cents)}</td>
                  </tr>
                ))}
                {servicos.map((l) => (
                  <tr key={l.rotulo} className="border-b border-nuvem-200">
                    <td className="px-2 py-2" colSpan={3}>
                      {l.rotulo}
                    </td>
                    <td className="px-2 py-2 text-right font-semibold">{money(l.valor)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* totais */}
        <section className="mt-4 flex justify-end">
          <div className="w-full max-w-xs text-sm">
            {temDesconto && (
              <>
                <Linha rotulo="Subtotal" valor={money(subtotal)} />
                <Linha rotulo="Desconto" valor={`- ${rotuloDesconto(r.discount_cents, r.discount_expr)}`} />
              </>
            )}
            <div className="mt-1 flex items-center justify-between rounded-lg bg-marca-600 px-3 py-2.5 text-white">
              <span className="text-xs font-bold uppercase tracking-wide">Total da Reserva</span>
              <span className="text-lg font-black">{money(r.total_cents)}</span>
            </div>
            {/* condicao comercial prevista (nao e o caixa): mesma fonte do contrato */}
            <div className="mt-2 rounded-lg bg-nuvem-100 px-3 py-2.5">
              <Linha rotulo="Adiantamento previsto" valor={money(adiantamento)} />
              <div className="flex items-center justify-between pt-1.5">
                <span className="text-stone-600">Restante previsto</span>
                <span className="font-semibold">{money(restante)}</span>
              </div>
            </div>
          </div>
        </section>

        {/* pagamento */}
        {(s.pix_key || s.bank_info) && (
          <section className="mt-5">
            <h2 className="mb-1.5 text-xs font-bold uppercase tracking-wide text-marca-600">Condições de Pagamento</h2>
            <div className="rounded-lg bg-nuvem-100 px-3 py-2.5 text-sm text-stone-700">
              {s.pix_key && (
                <p>
                  Pix: <b className="text-tinta-900">{s.pix_key}</b>
                </p>
              )}
              {s.bank_info && <p className="whitespace-pre-wrap">{s.bank_info}</p>}
            </div>
          </section>
        )}

        {/* observacoes */}
        {(r.notes || r.cancel_reason) && (
          <section className="mt-4">
            <h2 className="mb-1.5 text-xs font-bold uppercase tracking-wide text-marca-600">Observações</h2>
            <div className="rounded-lg bg-nuvem-100 px-3 py-2.5 text-sm text-stone-700">
              {r.notes && <p className="whitespace-pre-wrap">{r.notes}</p>}
              {r.cancel_reason && (
                <p className={r.notes ? "mt-2 whitespace-pre-wrap" : "whitespace-pre-wrap"}>
                  Motivo do cancelamento: {r.cancel_reason}
                </p>
              )}
            </div>
          </section>
        )}

        <footer className="mt-6 border-t border-nuvem-300 pt-3 text-center text-xs text-stone-500">
          <p className="font-semibold text-tinta-900">{s.company_name}</p>
          {contatoEmpresa && <p>{contatoEmpresa}</p>}
        </footer>
      </article>
    </div>
  );
}

function Linha({ rotulo, valor }: { rotulo: string; valor: string }) {
  return (
    <div className="flex items-center justify-between border-b border-nuvem-200 py-1.5">
      <span className="text-stone-600">{rotulo}</span>
      <span className="font-medium">{valor}</span>
    </div>
  );
}
