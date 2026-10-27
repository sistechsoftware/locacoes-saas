import Link from "next/link";
import { notFound } from "next/navigation";
import { requireModule } from "@/lib/auth";
import { temRecurso, bloquearRecurso, registrarNegacao } from "@/lib/plano-gate";
import {
  comprovantesDoPedido,
  eventosDoPedido,
  itensDoPedido,
  lojaDaEmpresa,
  pedidoDaEmpresa,
} from "@/lib/loja-db";
import { ESTADOS_PAGAMENTO, ESTADOS_PEDIDO } from "@/lib/loja";
import { Alerta, Badge, PageHeader, Row, Section, StatusBadge, BTN } from "@/components/ui";
import { aprovarPedidoAction, cancelarPedidoAction, criarOrcamentoAction, pagamentoAcao, recusarPedidoAction } from "../../actions";

export const dynamic = "force-dynamic";

const money = (c: number) => `R$ ${(Number(c || 0) / 100).toFixed(2).replace(".", ",")}`;
const dataBR = (iso: string) => (iso ? iso.slice(0, 10).split("-").reverse().join("/") : "-");

export default async function PedidoLojaPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ erro?: string; ok?: string }>;
}) {
  const ctx = await requireModule("configuracoes");
  if (!(await temRecurso(ctx.user, "loja_virtual"))) {
    registrarNegacao(ctx.companyId, "loja_virtual", "pagina-loja");
    bloquearRecurso("loja_virtual", ctx.user, "pagina");
  }
  const { erro, ok } = await searchParams;
  const { id } = await params;
  const orderId = Number(id);
  if (!Number.isInteger(orderId) || orderId <= 0) notFound();

  const [loja, pedido] = await Promise.all([lojaDaEmpresa(ctx.companyId), pedidoDaEmpresa(ctx.companyId, orderId)]);
  if (!pedido) notFound();

  const [itens, eventos, comprovantes] = await Promise.all([
    itensDoPedido(ctx.companyId, orderId),
    eventosDoPedido(ctx.companyId, orderId),
    comprovantesDoPedido(ctx.companyId, orderId),
  ]);

  const aberto = pedido.status === "aguardando_analise";
  const aguardandoPagamento = pedido.status === "aprovada_aguardando_pagamento";
  const comprovantePendente = ["comprovante_enviado", "em_analise"].includes(pedido.payment_status);
  const temComprovante = comprovantes.length > 0;

  return (
    <div className="space-y-4">
      <PageHeader
        title={`Solicitação ${pedido.number}`}
        subtitle={`Recebida pela Loja Virtual em ${pedido.created_at} · ${pedido.kind === "orcamento" ? "pedido de orçamento" : "pedido de reserva"}`}
        action={
          <>
            <StatusBadge defs={ESTADOS_PEDIDO} value={pedido.status} />
            <StatusBadge defs={ESTADOS_PAGAMENTO} value={pedido.payment_status} />
          </>
        }
      />

      {erro && <Alerta tone="vermelho">{erro}</Alerta>}
      {ok && <Alerta tone="verde">{ok}</Alerta>}

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="Ações">
          <div className="space-y-3 text-sm">
            {aberto && (
              <>
                <form action={aprovarPedidoAction}>
                  <input type="hidden" name="order_id" value={pedido.id} />
                  <button className={BTN.primario} type="submit">
                    Aprovar {loja?.signal_percent ? ` (cobra sinal de ${loja.signal_percent}%)` : ""}
                  </button>
                </form>
                <form action={criarOrcamentoAction}>
                  <input type="hidden" name="order_id" value={pedido.id} />
                  <button className={BTN.secundario} type="submit" disabled={!!pedido.quote_id}>
                    {pedido.quote_id ? "Já virou orçamento" : "Converter em orçamento"}
                  </button>
                </form>
                <form action={recusarPedidoAction} className="space-y-2">
                  <input type="hidden" name="order_id" value={pedido.id} />
                  <textarea name="motivo" className="campo" rows={2} placeholder="Motivo da recusa (vai para o histórico)" maxLength={300} />
                  <button className={BTN.perigo} type="submit">
                    Recusar solicitação
                  </button>
                </form>
              </>
            )}

            {aguardandoPagamento && (
              <div className="rounded-xl border border-nuvem-200 p-3">
                <p className="mb-2 font-semibold">
                  Aguardando pagamento: sinal de {money(pedido.signal_cents)} (total {money(pedido.total_cents)})
                  {pedido.payment_deadline_at ? ` — até ${pedido.payment_deadline_at.replace("T", " ")}` : ""}
                </p>
                {comprovantePendente && (
                  <div className="flex gap-2">
                    <form action={pagamentoAcao}>
                      <input type="hidden" name="order_id" value={pedido.id} />
                      <input type="hidden" name="pagamento" value="confirmar" />
                      <button className={BTN.sucesso} type="submit">
                        Confirmar pagamento
                      </button>
                    </form>
                    <form action={pagamentoAcao}>
                      <input type="hidden" name="order_id" value={pedido.id} />
                      <input type="hidden" name="pagamento" value="recusar" />
                      <button className={BTN.perigo} type="submit">
                        Recusar comprovante
                      </button>
                    </form>
                  </div>
                )}
                {!temComprovante && <p className="mt-2 text-xs text-stone-500">O cliente ainda não enviou comprovante.</p>}
                <form action={cancelarPedidoAction} className="mt-3 space-y-2">
                  <input type="hidden" name="order_id" value={pedido.id} />
                  <textarea name="motivo" className="campo" rows={2} placeholder="Motivo do cancelamento" maxLength={300} />
                  <button className={BTN.perigo} type="submit">
                    Cancelar solicitação
                  </button>
                </form>
              </div>
            )}

            {!aberto && !aguardandoPagamento && (
              <p className="text-xs text-stone-500">
                Solicitação encerrada. O histórico e os vínculos abaixo permanecem para consulta.
              </p>
            )}

            {pedido.reservation_id && (
              <p>
                <Link className="font-semibold text-marca-600 underline" href={`/reservas/${pedido.reservation_id}`}>
                  Abrir a reserva vinculada
                </Link>
              </p>
            )}
            {pedido.quote_id && (
              <p>
                <Link className="font-semibold text-marca-600 underline" href={`/orcamentos/${pedido.quote_id}`}>
                  Abrir o orçamento vinculado
                </Link>
              </p>
            )}
          </div>
        </Section>

        <Section title="Cliente">
          <div className="text-sm">
            <Row label="Nome" value={pedido.customer_name} />
            <Row label="Telefone" value={pedido.customer_phone ?? "-"} />
            <Row label="E-mail" value={pedido.customer_email ?? "-"} />
            <Row label="CPF/CNPJ" value={pedido.customer_doc ?? "-"} />
          </div>
        </Section>

        <Section title="Evento e entrega">
          <div className="text-sm">
            <Row label="Data do evento" value={dataBR(pedido.event_date)} />
            <Row label="Horário" value={pedido.event_time ?? "-"} />
            <Row label="Modalidade" value={pedido.needs_delivery ? "Entrega no endereço" : "Retirada no local"} />
            <Row label="Endereço" value={[pedido.address, pedido.district, pedido.city].filter(Boolean).join(", ") || "-"} />
            <Row label="CEP" value={pedido.zip ?? "-"} />
            <Row
              label="Frete"
              value={`${money(pedido.freight_cents)} · ${
                { nao_calculado: "não calculado", calculado: "calculado", pendente: "pendente de confirmação", isento: "isento" }[
                  pedido.freight_status
                ] ?? pedido.freight_status
              }`}
            />
            <Row label="Observações" value={pedido.notes || "-"} />
          </div>
        </Section>

        <Section title="Valores">
          <div className="text-sm">
            {itens.map((i: any) => (
              <Row
                key={i.id}
                label={`${i.qty}× ${i.name}${i.period_qty > 1 ? ` (${i.period_qty} períodos)` : ""}`}
                value={money(i.subtotal_cents)}
              />
            ))}
            <Row label="Itens" value={money(pedido.items_cents)} />
            <Row label="Frete" value={money(pedido.freight_cents)} />
            <Row label="Total" value={<b>{money(pedido.total_cents)}</b>} />
            {loja && loja.signal_percent > 0 && <Row label={`Sinal (${loja.signal_percent}%)`} value={money(pedido.signal_cents)} />}
          </div>
        </Section>

        <Section title="Comprovantes">
          {!temComprovante ? (
            <p className="text-sm text-stone-500">Nenhum comprovante enviado.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {comprovantes.map((c: any) => (
                <li key={c.id} className="flex items-center justify-between gap-2 rounded-lg border border-nuvem-200 px-3 py-2">
                  <span>
                    {c.mime} · {(c.size / 1024).toFixed(0)} KB · enviado em {c.submitted_at}
                    <span className="block text-xs text-stone-500">
                      {c.status === "aguardando" ? "aguardando verificação" : c.status === "confirmado" ? "confirmado" : "recusado"}
                    </span>
                  </span>
                  <a href={`/api/arquivo/${c.file_id}`} target="_blank" rel="noopener noreferrer" className="font-semibold text-marca-600 underline">
                    abrir
                  </a>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-xs text-stone-500">
            O arquivo é servido apenas com sessão da própria empresa — não existe link público permanente.
          </p>
        </Section>

        <Section title="Histórico">
          <ul className="space-y-1.5 text-sm">
            {eventos.map((e: any) => (
              <li key={e.id} className="flex gap-2">
                <span className="shrink-0 font-mono text-xs text-stone-400">{e.created_at.slice(5, 16)}</span>
                <span>
                  {e.description}
                  <span className="ml-1 text-xs text-stone-400">({e.actor})</span>
                </span>
              </li>
            ))}
          </ul>
        </Section>
      </div>

      <p className="text-xs text-stone-500">
        Origem: Loja Virtual{loja ? ` /loja/${loja.slug}` : ""} — identificador do pedido {pedido.number} (o link de
        acompanhamento do cliente é um token próprio e não expõe este painel).
      </p>
    </div>
  );
}
