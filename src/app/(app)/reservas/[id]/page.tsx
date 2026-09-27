import Link from "next/link";
import AvailabilityFilter from "@/components/AvailabilityFilter";
import { availabilityQuery, addMinutes, type AvailabilityParams } from "@/lib/availability-time";
import { stockOptions } from "@/lib/availability-settings";
import { HOLDING_STATUSES } from "@/lib/domain";
import { notFound } from "next/navigation";
import { all, one } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { logsFor } from "@/lib/audit";
import {
  getReservation,
  itemsSummary,
  reservationItems,
  reservationMoney,
  reservationOperations,
} from "@/lib/reservations";
import { messagesForReservation } from "@/lib/whatsapp";
import { checkReservationConflicts, compositionDrift, holdWindow, reservationPhysicalUsage } from "@/lib/stock";
import {
  CONTRACT_STATUS,
  DEPOSIT_STATUS,
  OPERATION_KINDS,
  OPERATION_STATUS,
  PAYMENT_METHODS,
  PAYMENT_METHOD_LABEL,
  RESERVATION_FLOW,
  RESERVATION_STATUS,
  paymentState,
  statusLabel,
} from "@/lib/domain";
import { dateBR, dateTimeBR, dateUtcBR, mapsLink, money, phoneBR, timeBR, today, utcParaLocal } from "@/lib/format";
import { Alerta, Badge, Card, Empty, LinkButton, PageHeader, Row, Section, Stat, StatusBadge } from "@/components/ui";
import { Icon } from "@/components/Icons";
import { SubmitButton } from "@/components/SubmitButton";
import { RESOLUTION_LABEL } from "@/lib/danos";
import { addPayment, changeStatus, deletePayment, deleteReservation, refreshComposition, saveDeposit } from "../actions";
import { consertarDano, estornarBaixaDano, resolverDano } from "../../operacao/actions";
import { generateContract } from "../../contratos/actions";
import { parcelarReserva, receberParcela } from "../../financeiro/receber-actions";
import { adiantamentosDaReserva, recebiveisDe } from "@/lib/receber";
import { recibosDaReserva, reciboQuitacaoDaReserva } from "@/lib/recibos";
import { gerarReciboDeposit, gerarReciboPayment, gerarQuitacaoCaucao, gerarQuitacaoLocacao } from "../../recibos/actions";
import { recompensasDisponiveis, simularUso } from "@/lib/fidelidade-db";
import { aplicarRecompensa } from "../fidelidade-actions";
import { situacaoParcela } from "@/lib/financeiro";
import { situacaoAdiantamento } from "@/lib/adiantamento";
import {
  atualizarAdiantamentoAction,
  cancelarAdiantamentoAction,
  confirmarAdiantamentoAction,
  criarAdiantamentoAction,
} from "../adiantamento-actions";

export const dynamic = "force-dynamic";

export default async function ReservaPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<AvailabilityParams & { erro?: string; aviso?: string }>;
}) {
  const user = await requireUser();
  const { id } = await params;
  const sp = await searchParams;
  const { erro, aviso } = sp;
  const r = await getReservation(Number(id));
  if (!r) notFound();

  /*
   * Leitura da tela em paralelo.
   *
   * Nenhuma destas consultas depende da outra — antes, cada uma esperava a
   * anterior, e a tela pagava a soma de ~17 voltas ao D1 (2 a 4s em 4G).
   * Junto, o tempo cai para o custo da consulta mais lenta do grupo.
   */
  const [
    items,
    m,
    ops,
    payments,
    // Recibos ja emitidos para os lancamentos desta reserva (pagamentos,
    // adiantamentos recebidos e caucao): uma consulta so, sem N+1. Nada aqui
    // altera lancamento — a leitura existe so para decidir entre "Gerar recibo"
    // e o link do recibo que ja existe.
    recibos,
    deposito,
    // contas ativas para os lancamentos de caixa desta tela: pagamento direto,
    // adiantamento (criacao e confirmacao) e recebimento de parcela
    contas,
    contracts,
    damages,
    historico,
    parcelasReceber,
    adiantamentos,
    // recompensas de fidelidade (vazio para reserva cancelada)
    recompensas,
    consumoFisico,
    // divergencia de composicao dos kits (vazia para reserva cancelada)
    divergencia,
  ] = await Promise.all([
    reservationItems(r.id),
    reservationMoney(r.id),
    reservationOperations(r.id),
    all<any>(`SELECT * FROM payments WHERE reservation_id = ? ORDER BY paid_at DESC, id DESC`, [r.id]),
    recibosDaReserva(r.id),
    one<any>(`SELECT id, status, received_at FROM deposits WHERE reservation_id = ? ORDER BY id DESC LIMIT 1`, [r.id]),
    all<any>(`SELECT id, name FROM financial_accounts WHERE active = 1 ORDER BY name`),
    all<any>(`SELECT * FROM contracts WHERE reservation_id = ? ORDER BY id DESC`, [r.id]),
    all<any>(
      `SELECT d.*, p.name AS product_name, p.kind AS product_kind FROM damage_reports d LEFT JOIN products p ON p.id = d.product_id
      WHERE d.reservation_id = ? ORDER BY d.id DESC`,
      [r.id],
    ),
    logsFor("reserva", r.id),
    recebiveisDe({ tipo: "locacao", reservationId: r.id }),
    adiantamentosDaReserva(r.id),
    r.status === "cancelada" ? Promise.resolve([]) : recompensasDisponiveis(r.customer_id),
    reservationPhysicalUsage(r.id),
    r.status === "cancelada" ? Promise.resolve([]) : compositionDrift(r.id),
  ]);
  const adiantamentoAberto = adiantamentos.find((a: any) => a.status === "aberta");
  const historicoAdiantamentos = adiantamentos.filter((a: any) => a.id !== adiantamentoAberto?.id);
  const reciboDeposit = deposito ? recibos.find((rc: any) => rc.deposit_id === deposito.id) : null;
  const reciboPorPagamento = new Map<number, any>(
    recibos.filter((rc: any) => rc.payment_id).map((rc: any) => [rc.payment_id, rc]),
  );
  // Quitação unificada: os recibos já vêm na lista (recibosDaReserva), mas a
  // consulta dedicada é a leitura canônica — devolve o documento por obrigação
  // (locação e caução) ou null quando ainda não existe.
  const quitacao = await reciboQuitacaoDaReserva(r.id);
  const recompensaUsada = await one<any>(
    `SELECT * FROM fidelity_rewards WHERE used_reservation_id = ? LIMIT 1`,
    [r.id],
  );
  // quanto cada recompensa cobriria desta reserva, para o operador decidir vendo o valor
  const previaRecompensas = await Promise.all(
    recompensas.map(async (rec: any) => ({ rec, previa: await simularUso(rec.id, r.id) })),
  );
  const temKit = items.some((i: any) => i.product_kind === "kit");
  const pay = paymentState(m.total, m.paid);
  const resumo = itemsSummary(items);
  const mensagens = await messagesForReservation(r, resumo, m.balance);
  const maps = mapsLink(r.address, r.district, r.city);

  const w = holdWindow(r);
  const query = availabilityQuery({ ...sp, inicio: w.from, fim: w.to, preparo: sp.preparo ?? (sp.consulta === "1" ? "0" : String(r.stock_consider_preparation)) });
  const options = await stockOptions(query);
  const occupiedUntil = addMinutes(w.to, options.preparationMinutes);
  const conflicts =
    (HOLDING_STATUSES as readonly string[]).includes(r.status)
      ? await checkReservationConflicts(r.id, options)
      : [];

  const flowIndex = (RESERVATION_FLOW as readonly string[]).indexOf(r.status);
  const proximo = flowIndex >= 0 && flowIndex < RESERVATION_FLOW.length - 1 ? RESERVATION_FLOW[flowIndex + 1] : null;

  return (
    <div className="space-y-4">
      <PageHeader
        title={r.number}
        subtitle={`${r.customer_name} - evento em ${dateBR(r.event_date)}${r.event_time ? ` às ${r.event_time}` : ""}`}
        action={
          <>
            <LinkButton href={`/reservas/${r.id}/editar`}>Editar</LinkButton>
            <LinkButton href={`/clientes/${r.customer_id}`}>Cliente</LinkButton>
          </>
        }
      />

      {erro && <Alerta tone="vermelho" title="Não foi possível concluir">{erro}</Alerta>}
      {aviso && <Alerta tone="ambar" title="Atenção">{aviso}</Alerta>}

      <AvailabilityFilter query={query} minutes={options.preparationMinutes} fixed />
      <p className="text-xs text-stone-500">Conferência da composição física gravada, excluindo a própria reserva. Fim da janela com preparação: {dateTimeBR(occupiedUntil)}. {(HOLDING_STATUSES as readonly string[]).includes(r.status) ? "Este status bloqueia estoque." : "Este status não bloqueia estoque."}</p>

      {conflicts.length > 0 && (
        <Alerta tone="vermelho" title="Conflito de estoque nesta reserva">
          <ul className="mt-1 space-y-0.5 text-xs">
            {conflicts.map((c) => (
              <li key={c.product_id}>
                <b>{c.product}</b>: reservados {c.requested}, disponível {c.available} (faltam {c.missing}).
              </li>
            ))}
          </ul>
          {r.stock_override ? (
            <p className="mt-1 text-xs font-semibold">Autorizado manualmente pelo administrador.</p>
          ) : (
            <p className="mt-1 text-xs font-semibold">Ajuste as quantidades ou as datas para resolver o conflito.</p>
          )}
        </Alerta>
      )}

      {divergencia.length > 0 && (
        <Alerta tone="ambar" title="A composição do kit mudou depois desta reserva">
          <p className="mt-0.5 text-xs">
            Esta reserva foi gravada com a composição antiga, então o estoque considera o consumo abaixo. Atualize para
            usar a composição atual dos kits. Quantidades, preços e total não mudam.
          </p>
          <ul className="mt-1 space-y-0.5 text-xs">
            {divergencia.map((d) => (
              <li key={d.product}>
                <b>{d.product}</b>: gravado {d.gravado}, pela composição atual seria {d.atual}.
              </li>
            ))}
          </ul>
          <form action={refreshComposition} className="mt-2">
            <input type="hidden" name="consider_preparation" value={query.considerPreparation ? "1" : "0"} />
            <input type="hidden" name="id" value={r.id} />
            <SubmitButton variant="secundario" className="px-3 py-1.5 text-xs">
              Atualizar composição
            </SubmitButton>
          </form>
        </Alerta>
      )}

      {/* status e fluxo */}
      <Card>
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge defs={RESERVATION_STATUS} value={r.status} />
          <Badge tone={pay.tone}>Pagamento: {pay.label}</Badge>
          <Badge tone={m.depositStatus === "recebida" ? "verde" : "ambar"}>
            Caução: {statusLabel(DEPOSIT_STATUS, m.depositStatus)}
          </Badge>
          {r.contract_status && (
            <Badge tone={r.contract_status === "assinado" ? "verde" : "ambar"}>
              Contrato: {statusLabel(CONTRACT_STATUS, r.contract_status)}
            </Badge>
          )}
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          {proximo && r.status !== "cancelada" && (
            <form action={changeStatus}>
              <input type="hidden" name="consider_preparation" value={query.considerPreparation ? "1" : "0"} />
              <input type="hidden" name="id" value={r.id} />
              <input type="hidden" name="status" value={proximo} />
              <SubmitButton variant="sucesso">
                Avançar para: {statusLabel(RESERVATION_STATUS, proximo)}
              </SubmitButton>
            </form>
          )}
          <form action={changeStatus} className="flex flex-wrap items-center gap-2">
            <input type="hidden" name="consider_preparation" value={query.considerPreparation ? "1" : "0"} />
            <input type="hidden" name="id" value={r.id} />
            <select name="status" defaultValue={r.status} className="campo w-auto">
              {RESERVATION_STATUS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
            <SubmitButton variant="secundario">Alterar status</SubmitButton>
          </form>
        </div>
      </Card>

      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <Stat label="Total" value={money(m.total)} />
        <Stat label="Pago" value={money(m.paid)} tone="verde" />
        <Stat label="Saldo" value={money(m.balance)} tone={m.balance > 0 ? "vermelho" : "verde"} />
        <Stat label="Caução" value={money(m.deposit)} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="Dados da reserva">
          <Row label="Cliente" value={<Link href={`/clientes/${r.customer_id}`} className="text-marca-600">{r.customer_name}</Link>} />
          <Row label="Telefone" value={phoneBR(r.customer_phone) || "-"} />
          <Row label="Data do evento" value={`${dateBR(r.event_date)}${r.event_time ? ` às ${r.event_time}` : ""}`} />
          <Row label="Endereço" value={[r.address, r.district, r.city].filter(Boolean).join(", ") || "-"} />
          <Row label="Entrega" value={dateTimeBR(r.delivery_at)} />
          <Row label="Retirada" value={dateTimeBR(r.pickup_at)} />
          <Row
            label="Serviços"
            value={
              [
                r.needs_delivery && "entrega",
                r.needs_pickup && "retirada",
                r.needs_assembly && "montagem",
                r.needs_disassembly && "desmontagem",
              ]
                .filter(Boolean)
                .join(", ") || "-"
            }
          />
          {r.notes && <Row label="Observações" value={r.notes} />}
          {r.cancel_reason && <Row label="Motivo do cancelamento" value={r.cancel_reason} />}

          {maps && (
            <a
              href={maps}
              target="_blank"
              rel="noreferrer"
              className="mt-3 inline-flex items-center gap-2 rounded-xl border border-nuvem-300 bg-white px-4 py-2.5 text-sm font-semibold"
            >
              <Icon name="operacao" className="h-4 w-4" /> Abrir rota no Google Maps
            </a>
          )}
        </Section>

        <Section title={`Itens (${items.length})`}>
          {items.length === 0 ? (
            <Empty>Nenhum item.</Empty>
          ) : (
            <ul className="divide-y divide-nuvem-200">
              {items.map((i) => (
                <li key={i.id} className="flex items-center justify-between gap-3 py-2">
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-semibold text-tinta-900">
                      {i.qty} x {i.product_name}
                      {i.product_kind === "kit" && (
                        <span className="ml-1.5 rounded bg-destaque-100 px-1.5 py-0.5 text-[0.6rem] font-bold uppercase text-destaque-700">
                          kit
                        </span>
                      )}
                    </span>
                    <span className="block text-xs text-stone-500">
                      {money(i.unit_price_cents)} cada
                      {i.discount_cents > 0 ? ` · desconto ${money(i.discount_cents)}` : ""}
                    </span>
                  </span>
                  <span className="shrink-0 text-sm font-bold">{money(i.subtotal_cents)}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-3 space-y-1 rounded-xl bg-nuvem-100 p-3 text-sm">
            <Row label="Produtos" value={money(r.items_cents)} />
            <Row label="Frete" value={money(r.freight_cents)} />
            <Row label="Montagem" value={money(r.assembly_cents)} />
            <Row label="Desmontagem" value={money(r.disassembly_cents)} />
            <Row label="Outros" value={money(r.other_cents)} />
            <Row label="Desconto" value={"- " + money(r.discount_cents)} />
            <div className="flex items-center justify-between pt-1 text-base font-bold">
              <span>Total</span>
              <span>{money(r.total_cents)}</span>
            </div>
          </div>
        </Section>
      </div>

      {temKit && (
        <Section title="Consumo de estoque">
          <p className="mb-2 text-sm text-stone-600">
            Itens físicos que esta reserva ocupa. Kits aparecem expandidos nos seus componentes.
          </p>
          <ul className="divide-y divide-nuvem-200">
            {consumoFisico.map((c: any) => (
              <li key={c.product_id} className="flex items-center justify-between py-2 text-sm">
                <Link href={`/estoque/${c.product_id}`} className="truncate text-marca-600">
                  {c.product_name}
                </Link>
                <span className="shrink-0 font-bold text-tinta-900">{c.qty} un.</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {/* operacoes */}
      <Section
        title="Agenda operacional"
        action={<Link href="/operacao" className="text-xs font-semibold text-marca-600">Ver operação</Link>}
      >
        {ops.length === 0 ? (
          <Empty>Nenhuma operação agendada. Marque entrega, retirada ou montagem ao editar a reserva.</Empty>
        ) : (
          <div className="space-y-2">
            {ops.map((o) => {
              const kind = OPERATION_KINDS.find((k) => k.value === o.kind)!;
              return (
                <Link
                  key={o.id}
                  href={`/operacao/${o.id}`}
                  className="flex items-center gap-3 rounded-xl border border-nuvem-300 bg-white p-3"
                >
                  <span className="text-lg">{kind.icon}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-bold text-tinta-900">
                      {kind.label} - {dateBR(o.scheduled_at)} {timeBR(o.scheduled_at)}
                    </span>
                    <span className="block text-xs text-stone-500">
                      {o.assignee ? `Responsável: ${o.assignee}` : "Sem responsável definido"}
                      {o.vehicle_name ? ` - ${o.vehicle_name}` : ""}
                    </span>
                  </span>
                  <StatusBadge defs={OPERATION_STATUS} value={o.status} />
                </Link>
              );
            })}
          </div>
        )}
      </Section>

      {(recompensaUsada || previaRecompensas.length > 0) && (
        <Section title="Fidelidade">
          {recompensaUsada ? (
            <Alerta tone="verde" title="Recompensa aplicada nesta locação">
              {recompensaUsada.used_kits} kit(s) gratuitos, {money(recompensaUsada.used_discount_cents ?? 0)} de
              desconto. O valor entrou no desconto da reserva; frete e itens avulsos seguem cobrados.
            </Alerta>
          ) : (
            <>
              <p className="mb-2 text-sm text-stone-600">
                Este cliente tem recompensa disponível. Aplicar lança o desconto no campo de desconto da reserva.
              </p>
              <ul className="space-y-2">
                {previaRecompensas.map(({ rec, previa }) => (
                  <li key={rec.id} className="rounded-xl border border-nuvem-300 bg-white p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span>
                        <span className="text-sm font-bold text-tinta-900">Até {rec.kit_quantity} kits grátis</span>
                        <span className="ml-2 text-xs text-stone-500">
                          conquistada em {dateBR(rec.earned_at)}
                          {rec.expires_on ? ` · vale até ${dateBR(rec.expires_on)}` : ""}
                        </span>
                      </span>
                      {previa && previa.kitsGratis > 0 ? (
                        <Badge tone="verde">
                          cobre {previa.kitsGratis} kit(s) · {money(previa.descontoCents)}
                        </Badge>
                      ) : (
                        <Badge tone="cinza">sem kit nesta reserva</Badge>
                      )}
                    </div>
                    {previa && previa.kitsGratis > 0 && r.status !== "cancelada" && (
                      <form action={aplicarRecompensa} className="mt-2">
                        <input type="hidden" name="reservation_id" value={r.id} />
                        <input type="hidden" name="reward_id" value={rec.id} />
                        <SubmitButton confirm={`Aplicar a recompensa e descontar ${money(previa.descontoCents)}?`}>
                          Utilizar recompensa
                        </SubmitButton>
                      </form>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
        </Section>
      )}

      <Section title="Adiantamento">
        {adiantamentoAberto ? (
          <AdiantamentoAberto entry={adiantamentoAberto} reservationId={r.id} hoje={today()} contas={contas} />
        ) : r.status !== "cancelada" ? (
          <>
            <p className="mb-2 text-sm text-stone-600">
              Saldo disponível para adiantar: {money(Math.max(0, m.total - m.paid - m.scheduledAdvance))}.
            </p>
            <form action={criarAdiantamentoAction} className="space-y-3">
              <input type="hidden" name="reservation_id" value={r.id} />
              <div className="grid grid-cols-2 gap-2">
                <label className="block">
                  <span className="rotulo">Valor (R$)</span>
                  <input name="amount" inputMode="decimal" required className="campo" />
                </label>
                <label className="block">
                  <span className="rotulo">Forma de pagamento</span>
                  <select name="method" defaultValue="pix" className="campo">
                    {PAYMENT_METHODS.map((mth) => (
                      <option key={mth} value={mth}>
                        {PAYMENT_METHOD_LABEL[mth]}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="flex flex-col gap-2 sm:flex-row">
                <label className="flex flex-1 items-center gap-2 rounded-xl border border-nuvem-300 p-3 text-sm has-[:checked]:border-marca-400 has-[:checked]:bg-marca-50">
                  <input type="radio" name="type" value="agora" defaultChecked />
                  Pago agora
                </label>
                <label className="flex flex-1 items-center gap-2 rounded-xl border border-nuvem-300 p-3 text-sm has-[:checked]:border-marca-400 has-[:checked]:bg-marca-50">
                  <input type="radio" name="type" value="agendado" />
                  Agendar pagamento
                </label>
              </div>
              <label className="block max-w-56">
                <span className="rotulo">Data do pagamento (ou prevista, se agendado)</span>
                <input name="date" type="date" defaultValue={today()} className="campo" />
              </label>
              <label className="block max-w-56">
                <span className="rotulo">Conta Corrente</span>
                <select name="account_id" defaultValue={contas.length === 1 ? String(contas[0].id) : ""} className="campo">
                  <option value="">Sem conta</option>
                  {contas.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
              <SubmitButton>Registrar adiantamento</SubmitButton>
            </form>
          </>
        ) : (
          <p className="text-sm text-stone-500">Reserva cancelada.</p>
        )}

        {historicoAdiantamentos.length > 0 && (
          <details className="mt-3">
            <summary className="cursor-pointer text-xs font-semibold text-marca-600">
              Histórico de adiantamentos ({historicoAdiantamentos.length})
            </summary>
            <ul className="mt-2 space-y-1.5">
              {historicoAdiantamentos.map((a: any) => {
                const sit = situacaoAdiantamento(a, a.recebido_cents, today());
                const pagamento = payments.find((p: any) => p.entry_id === a.id);
                const reciboAdiantamento = pagamento ? reciboPorPagamento.get(pagamento.id) : null;
                return (
                  <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-nuvem-200 p-2.5 text-sm">
                    <span>
                      {money(a.amount_cents)}
                      <span className="ml-2 text-xs text-stone-500">
                        {sit === "recebido" ? `recebido em ${dateBR(pagamento?.paid_at ?? a.due_date)}` : `previsto para ${dateBR(a.due_date)}`}
                      </span>
                    </span>
                    <span className="flex items-center gap-1.5">
                      {/* O adiantamento recebido virou pagamento em payments; o recibo
                          aponta para ele e identifica o lançamento como adiantamento
                          pelas observacoes do pagamento. Nada aqui altera a entry. */}
                      {sit === "recebido" && pagamento &&
                        (reciboAdiantamento ? (
                          <Link
                            href={`/recibos/${reciboAdiantamento.id}`}
                            className="rounded-xl border border-nuvem-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-marca-600 hover:bg-nuvem-50"
                          >
                            Recibo {reciboAdiantamento.number}
                          </Link>
                        ) : (
                          <form action={gerarReciboPayment}>
                            <input type="hidden" name="payment_id" value={pagamento.id} />
                            <input type="hidden" name="voltar" value={`/reservas/${r.id}`} />
                            <SubmitButton variant="secundario" className="px-2.5 py-1.5 text-xs">
                              Gerar recibo
                            </SubmitButton>
                          </form>
                        ))}
                      <Badge tone={sit === "recebido" ? "verde" : sit === "cancelado" ? "cinza" : "vermelho"}>{sit}</Badge>
                    </span>
                  </li>
                );
              })}
            </ul>
          </details>
        )}
      </Section>

      <Section title={`Parcelamento (${parcelasReceber.length})`}>
        {parcelasReceber.length === 0 ? (
          <>
            <p className="mb-2 text-sm text-stone-600">
              Sem parcelamento.{" "}
              {m.paid > 0
                ? `Já recebidos ${money(m.paid)}; as parcelas dividem o saldo de ${money(Math.max(0, m.total - m.paid))}.`
                : `O total de ${money(m.total)} vira uma conta a receber só, ou divida em parcelas com vencimento próprio.`}{" "}
              O caixa registra apenas o que for efetivamente recebido.
            </p>
            <form action={parcelarReserva} className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              <input type="hidden" name="reservation_id" value={r.id} />
              <label className="block">
                <span className="rotulo">Parcelas</span>
                <input name="parcelas" type="number" min={1} max={60} defaultValue={1} className="campo" />
              </label>
              <label className="block">
                <span className="rotulo">1º vencimento</span>
                <input name="primeiro_vencimento" type="date" defaultValue={r.event_date} className="campo" />
              </label>
              <label className="block">
                <span className="rotulo">Conta Corrente</span>
                <select name="account_id" defaultValue={contas.length === 1 ? String(contas[0].id) : ""} className="campo">
                  <option value="">Sem conta</option>
                  {contas.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
              <div className="flex items-end">
                <SubmitButton className="w-full">Gerar parcelas</SubmitButton>
              </div>
            </form>
          </>
        ) : (
          <ul className="space-y-2">
            {parcelasReceber.map((p: any) => {
              const sit = situacaoParcela(p, p.recebido_cents, today());
              const falta = Math.max(0, p.amount_cents - p.recebido_cents);
              return (
                <li key={p.id} className="rounded-xl border border-nuvem-300 bg-white p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-sm font-bold text-tinta-900">
                      {p.installment}/{p.installments_total} - {money(p.amount_cents)}
                      <span className="ml-2 text-xs font-normal text-stone-500">vence em {dateBR(p.due_date)}</span>
                    </span>
                    <Badge
                      tone={
                        sit === "quitada" ? "verde" : sit === "vencida" ? "vermelho" : sit === "parcial" ? "ambar" : "cinza"
                      }
                    >
                      {sit}
                    </Badge>
                  </div>
                  {sit !== "quitada" && (
                    <form action={receberParcela} className="mt-2 grid grid-cols-2 gap-2">
                      <input type="hidden" name="entry_id" value={p.id} />
                      <input
                        name="amount"
                        defaultValue={(falta / 100).toFixed(2)}
                        inputMode="decimal"
                        className="campo"
                        aria-label="Valor"
                      />
                      <input name="paid_at" type="date" defaultValue={today()} className="campo" />
                      <select name="method" className="campo col-span-2">
                        {PAYMENT_METHODS.map((mth) => (
                          <option key={mth} value={mth}>
                            {PAYMENT_METHOD_LABEL[mth]}
                          </option>
                        ))}
                      </select>
                      <label className="col-span-2 block">
                        <span className="rotulo">Conta Corrente</span>
                        <select
                          name="account_id"
                          defaultValue={p.account_id ?? (contas.length === 1 ? String(contas[0].id) : "")}
                          className="campo"
                        >
                          <option value="">Sem conta</option>
                          {contas.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <div className="col-span-2">
                        <SubmitButton className="w-full">Registrar recebimento</SubmitButton>
                      </div>
                    </form>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      {/* financeiro */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="Pagamentos">
          <form action={addPayment} className="grid grid-cols-2 gap-2">
            <input type="hidden" name="reservation_id" value={r.id} />
            <input name="amount" placeholder="Valor (R$)" inputMode="decimal" className="campo" required />
            <input name="paid_at" type="date" defaultValue={today()} className="campo" />
            <select name="method" className="campo">
              {PAYMENT_METHODS.map((mth) => (
                <option key={mth} value={mth}>
                  {PAYMENT_METHOD_LABEL[mth]}
                </option>
              ))}
            </select>
            <input name="notes" placeholder="Observação" className="campo" />
            <label className="col-span-2 block">
              <span className="rotulo">Conta Corrente</span>
              <select name="account_id" defaultValue={contas.length === 1 ? String(contas[0].id) : ""} className="campo">
                <option value="">Sem conta (dinheiro fora das contas cadastradas)</option>
                {contas.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="col-span-2">
              <SubmitButton className="w-full">Registrar pagamento</SubmitButton>
            </div>
          </form>

          <div className="mt-3">
            {payments.length === 0 ? (
              <Empty>Nenhum pagamento registrado.</Empty>
            ) : (
              <ul className="divide-y divide-nuvem-200">
                {payments.map((p) => (
                  <li key={p.id} className="flex items-center justify-between gap-2 py-2">
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold">{money(p.amount_cents)}</span>
                      <span className="block text-xs text-stone-500">
                        {dateBR(p.paid_at)} - {PAYMENT_METHOD_LABEL[p.method] ?? p.method}
                        {p.notes ? ` - ${p.notes}` : ""}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-1.5">
                      {/* Recibo do lancamento: se ja existe, abre direto; senao gera agora.
                          Nao muda o pagamento: so le o id dele. */}
                      {p.amount_cents > 0 &&
                        (reciboPorPagamento.get(p.id) ? (
                          <Link
                            href={`/recibos/${reciboPorPagamento.get(p.id).id}`}
                            className="rounded-xl border border-nuvem-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-marca-600 hover:bg-nuvem-50"
                          >
                            Recibo {reciboPorPagamento.get(p.id).number}
                          </Link>
                        ) : (
                          <form action={gerarReciboPayment}>
                            <input type="hidden" name="payment_id" value={p.id} />
                            <input type="hidden" name="voltar" value={`/reservas/${r.id}`} />
                            <SubmitButton variant="secundario" className="px-2.5 py-1.5 text-xs">
                              Gerar recibo
                            </SubmitButton>
                          </form>
                        ))}
                      {user.role === "admin" && (
                        <form action={deletePayment}>
                          <input type="hidden" name="payment_id" value={p.id} />
                          <SubmitButton variant="perigo" confirm="Remover este pagamento?" className="px-2.5 py-1.5 text-xs">
                            Remover
                          </SubmitButton>
                        </form>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-2 flex items-center justify-between rounded-xl bg-nuvem-100 px-3 py-2 text-sm font-bold">
              <span>Saldo</span>
              <span className={m.balance <= 0 ? "text-emerald-600" : "text-red-600"}>{money(m.balance)}</span>
            </div>
            {/* Quitação unificada da locação: aparece quando quitada. O recibo de
                quitação é ADICIONAL aos recibos individuais, nunca os substitui. */}
            {m.total > 0 && m.balance <= 0 && (
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2.5">
                <span className="text-xs font-semibold text-emerald-800">
                  Locação quitada — recibo unificado com o total recebido
                </span>
                {quitacao.locacao ? (
                  <Link
                    href={`/recibos/${quitacao.locacao.id}`}
                    className="rounded-xl border border-nuvem-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-marca-600 hover:bg-nuvem-50"
                  >
                    Quitação {quitacao.locacao.number}
                  </Link>
                ) : (
                  <form action={gerarQuitacaoLocacao}>
                    <input type="hidden" name="reservation_id" value={r.id} />
                    <SubmitButton variant="secundario" className="px-2.5 py-1.5 text-xs">
                      Emitir quitação
                    </SubmitButton>
                  </form>
                )}
              </div>
            )}
          </div>
        </Section>

        <Section title="Caução">
          <form action={saveDeposit} className="grid grid-cols-2 gap-2">
            <input type="hidden" name="reservation_id" value={r.id} />
            <label className="col-span-2 block">
              <span className="rotulo">Valor da caução</span>
              <input name="amount" defaultValue={(m.deposit / 100).toFixed(2)} inputMode="decimal" className="campo" />
            </label>
            <label className="block">
              <span className="rotulo">Forma de recebimento</span>
              <select name="method" className="campo" defaultValue="pix">
                {PAYMENT_METHODS.map((mth) => (
                  <option key={mth} value={mth}>
                    {PAYMENT_METHOD_LABEL[mth]}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="rotulo">Status</span>
              <select name="status" defaultValue={m.depositStatus} className="campo">
                {DEPOSIT_STATUS.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="rotulo">Recebida em</span>
              <input name="received_at" type="date" className="campo" />
            </label>
            <label className="block">
              <span className="rotulo">Devolvida em</span>
              <input name="returned_at" type="date" className="campo" />
            </label>
            <label className="block">
              <span className="rotulo">Valor retido</span>
              <input name="retained" defaultValue={(m.depositRetained / 100).toFixed(2)} inputMode="decimal" className="campo" />
            </label>
            <label className="block">
              <span className="rotulo">Motivo da retenção</span>
              <input name="reason" className="campo" placeholder="Ex.: 2 cadeiras quebradas" />
            </label>
            <div className="col-span-2">
              <SubmitButton className="w-full">Salvar caução</SubmitButton>
            </div>
          </form>

          {/* Quitação unificada da caução: quando as cauções da reserva estão
              integralmente em caixa. Documento ADICIONAL ao recibo individual. */}
          {m.deposit > 0 && deposito?.status !== "nao_recebida" && (
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2.5">
              <span className="text-xs font-semibold text-emerald-800">
                Caução quitada — recibo unificado com o total recebido
              </span>
              {quitacao.caucao ? (
                <Link
                  href={`/recibos/${quitacao.caucao.id}`}
                  className="rounded-xl border border-nuvem-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-marca-600 hover:bg-nuvem-50"
                >
                  Quitação {quitacao.caucao.number}
                </Link>
              ) : (
                <form action={gerarQuitacaoCaucao}>
                  <input type="hidden" name="reservation_id" value={r.id} />
                  <SubmitButton variant="secundario" className="px-2.5 py-1.5 text-xs">
                    Emitir quitação
                  </SubmitButton>
                </form>
              )}
            </div>
          )}

          {/* Recibo da caucao: so para caucao recebida, que tem valor a comprovar.
              Leitura pura do deposito — a acao nao altera o registro dela. */}
          {deposito && deposito.status !== "nao_recebida" && deposito.received_at && (
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl bg-nuvem-50 px-3 py-2.5">
              <span className="text-xs text-stone-500">
                Recibo da caução recebida em {dateBR(deposito.received_at)}
              </span>
              {reciboDeposit ? (
                <Link
                  href={`/recibos/${reciboDeposit.id}`}
                  className="rounded-xl border border-nuvem-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-marca-600 hover:bg-nuvem-50"
                >
                  Recibo {reciboDeposit.number}
                </Link>
              ) : (
                <form action={gerarReciboDeposit}>
                  <input type="hidden" name="deposit_id" value={deposito.id} />
                  <input type="hidden" name="voltar" value={`/reservas/${r.id}`} />
                  <SubmitButton variant="secundario" className="px-2.5 py-1.5 text-xs">
                    Gerar recibo
                  </SubmitButton>
                </form>
              )}
            </div>
          )}

          {damages.length > 0 && (
            <div className="mt-3">
              <h3 className="mb-1.5 text-xs font-bold uppercase text-stone-500">Danos registrados</h3>
              <ul className="space-y-2 text-sm">
                {damages.map((d) => {
                  const pendente = d.resolution_status === "registrada" || d.resolution_status === "estornada" || d.resolution_status === "consertada";
                  const ehKit = d.product_kind === "kit";
                  return (
                    <li key={d.id} className="rounded-lg bg-red-50 px-3 py-2 text-red-800">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold">
                          {d.qty}x {d.product_name ?? "equipamento"} · {d.damage_type ?? "dano"}
                        </span>
                        <Badge tone={d.resolution_status === "baixada" ? "cinza" : d.resolution_status === "em_manutencao" ? "roxo" : d.resolution_status === "estornada" ? "ambar" : "vermelho"}>
                          {RESOLUTION_LABEL[d.resolution_status] ?? "Registrada"}
                        </Badge>
                        <span>· estimado {money(d.estimated_cents)}</span>
                        {d.charged_cents > 0 && <span>· descontado {money(d.charged_cents)}</span>}
                      </div>
                      {d.description ? <span className="block text-xs opacity-80">{d.description}</span> : null}                      {pendente && (
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          <form action={resolverDano} className="flex items-center gap-1">
                            <input type="hidden" name="damage_id" value={d.id} />
                            <input type="hidden" name="reservation_id" value={r.id} />
                            <input type="hidden" name="action" value="baixa" />
                            <SubmitButton variant="perigo" confirm={ehKit ? `Baixar ${d.qty}x ${d.product_name ?? "kit"} do estoque? A baixa será expandida nos componentes físicos do kit.` : `Baixar definitivamente ${d.qty} un. de ${d.product_name ?? "do estoque"}? O disponível será reduzido.`} className="px-2 py-1 text-xs">
                              Baixar do estoque
                            </SubmitButton>
                          </form>
                          {!ehKit && (
                            <form action={resolverDano} className="flex items-center gap-1">
                              <input type="hidden" name="damage_id" value={d.id} />
                              <input type="hidden" name="reservation_id" value={r.id} />
                              <input type="hidden" name="action" value="manutencao" />
                              <SubmitButton variant="secundario" className="px-2 py-1 text-xs">
                                Enviar p/ manutenção
                              </SubmitButton>
                            </form>
                          )}
                        </div>
                      )}
                      {ehKit && pendente && (
                        <p className="mt-1 text-xs opacity-80">
                          A baixa de um kit é expandida nos componentes físicos (ex.: 1 kit = 1 mesa + 4 cadeiras). Manutenção deve ser registrada no componente avulso.
                        </p>
                      )}

                      {d.resolution_status === "baixada" && (
                        <form action={estornarBaixaDano} className="mt-2 flex items-center gap-1">
                          <input type="hidden" name="damage_id" value={d.id} />
                          <input type="hidden" name="reservation_id" value={r.id} />
                          <input name="motivo" placeholder="Motivo do estorno" className="rounded-lg border border-red-200 px-2 py-1 text-xs" />
                          <SubmitButton variant="secundario" className="px-2 py-1 text-xs">
                            Estornar baixa
                          </SubmitButton>
                        </form>
                      )}

                      {d.resolution_status === "em_manutencao" && (
                        <form action={consertarDano} className="mt-2">
                          <input type="hidden" name="damage_id" value={d.id} />
                          <input type="hidden" name="reservation_id" value={r.id} />
                          <SubmitButton variant="sucesso" className="px-2 py-1 text-xs">
                            Consertado: devolver ao disponível
                          </SubmitButton>
                        </form>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </Section>
      </div>

      {/* contrato e whatsapp */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="Contrato / Termo de Responsabilidade">
          {contracts.length === 0 ? (
            <>
              <p className="mb-3 text-sm text-stone-500">
                Nenhum contrato gerado. O documento é montado automaticamente com os dados desta reserva.
              </p>
              <form action={generateContract}>
                <input type="hidden" name="reservation_id" value={r.id} />
                <SubmitButton>              Gerar Contrato</SubmitButton>
              </form>
            </>
          ) : (
            <div className="space-y-2">
              {contracts.map((c) => (
                <Link
                  key={c.id}
                  href={`/contratos/${c.id}`}
                  className="flex items-center justify-between gap-2 rounded-xl border border-nuvem-300 bg-white p-3"
                >
                  <span>
                    <span className="block text-sm font-bold">{c.number}</span>
                    <span className="block text-xs text-stone-500">Gerado em {dateUtcBR(c.created_at)}</span>
                  </span>
                  <StatusBadge defs={CONTRACT_STATUS} value={c.status} />
                </Link>
              ))}
            </div>
          )}
        </Section>

        <Section title="Mensagens de WhatsApp">
          {r.customer_whatsapp || r.customer_phone ? (
            <div className="space-y-2">
              {mensagens.map((msg) => (
                <a
                  key={msg.key}
                  href={msg.href ?? "#"}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-sm font-semibold text-emerald-800"
                >
                  <Icon name="whatsapp" className="h-4 w-4 shrink-0" />
                  <span className="min-w-0 flex-1">
                    <span className="block">{msg.label}</span>
                    <span className="block truncate text-xs font-normal opacity-80">{msg.text}</span>
                  </span>
                </a>
              ))}
            </div>
          ) : (
            <Empty>Cliente sem telefone cadastrado.</Empty>
          )}
        </Section>
      </div>

      {historico.length > 0 && (
        <Section title="Histórico da reserva">
          <ul className="space-y-1.5 text-sm">
            {historico.slice(0, 20).map((h: any) => (
              <li key={h.id} className="flex gap-2 text-stone-600">
                <span className="shrink-0 text-xs text-stone-400">{utcParaLocal(h.created_at)}</span>
                <span>{h.summary}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {user.role === "admin" && (
        <Card className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-tinta-900">Área do administrador</p>
            <p className="text-xs text-stone-500">
              Prefira cancelar a reserva: o cancelamento preserva o histórico e libera o estoque.
            </p>
          </div>
          <form action={deleteReservation}>
            <input type="hidden" name="id" value={r.id} />
            <SubmitButton
              variant="perigo"
              confirm={`Excluir definitivamente a reserva ${r.number} e todos os seus pagamentos? Esta ação não pode ser desfeita.`}
            >
              Excluir Reserva
            </SubmitButton>
          </form>
        </Card>
      )}
    </div>
  );
}

/**
 * O adiantamento agendado (aberta) desta reserva, com edicao, confirmacao e
 * cancelamento. So existe um por vez, entao a tela tem um lugar so para isso.
 */
function AdiantamentoAberto({
  entry,
  reservationId,
  hoje,
  contas,
}: {
  entry: any;
  reservationId: number;
  hoje: string;
  contas: { id: number; name: string }[];
}) {
  const sit = situacaoAdiantamento(entry, entry.recebido_cents, hoje);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span>
          <span className="text-base font-bold text-tinta-900">{money(entry.amount_cents)}</span>
          <span className="ml-2 text-xs text-stone-500">
            previsto para {dateBR(entry.due_date)} · {PAYMENT_METHOD_LABEL[entry.expected_method] ?? entry.expected_method}
          </span>
        </span>
        <Badge tone={sit === "atrasado" ? "vermelho" : "ambar"}>{sit}</Badge>
      </div>

      <form action={confirmarAdiantamentoAction} className="grid grid-cols-2 gap-2 rounded-xl border border-nuvem-300 bg-white p-3">
        <input type="hidden" name="entry_id" value={entry.id} />
        <input type="hidden" name="reservation_id" value={reservationId} />
        <label className="col-span-2 text-xs font-bold uppercase text-stone-500">Confirmar recebimento</label>
        <label className="block">
          <span className="rotulo">Forma efetiva</span>
          <select name="method" defaultValue={entry.expected_method ?? "pix"} className="campo">
            {PAYMENT_METHODS.map((m) => (
              <option key={m} value={m}>
                {PAYMENT_METHOD_LABEL[m]}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="rotulo">Data do recebimento</span>
          <input name="paid_at" type="date" defaultValue={hoje} className="campo" />
        </label>
        <label className="col-span-2 block">
          <span className="rotulo">Conta Corrente</span>
          <select name="account_id" defaultValue={entry.account_id ?? (contas.length === 1 ? String(contas[0].id) : "")} className="campo">
            <option value="">Sem conta</option>
            {contas.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <div className="col-span-2">
          <SubmitButton className="w-full">Confirmar recebimento</SubmitButton>
        </div>
      </form>

      <details>
        <summary className="cursor-pointer text-xs font-semibold text-marca-600">Alterar valor, data ou forma</summary>
        <form action={atualizarAdiantamentoAction} className="mt-2 grid grid-cols-2 gap-2">
          <input type="hidden" name="entry_id" value={entry.id} />
          <input type="hidden" name="reservation_id" value={reservationId} />
          <label className="block">
            <span className="rotulo">Valor (R$)</span>
            <input name="amount" defaultValue={(entry.amount_cents / 100).toFixed(2)} inputMode="decimal" className="campo" />
          </label>
          <label className="block">
            <span className="rotulo">Data prevista</span>
            <input name="date" type="date" defaultValue={entry.due_date} className="campo" />
          </label>
          <label className="block col-span-2">
            <span className="rotulo">Forma prevista</span>
            <select name="method" defaultValue={entry.expected_method ?? "pix"} className="campo">
              {PAYMENT_METHODS.map((m) => (
                <option key={m} value={m}>
                  {PAYMENT_METHOD_LABEL[m]}
                </option>
              ))}
            </select>
          </label>
          <div className="col-span-2">
            <SubmitButton variant="secundario" className="w-full">
              Salvar alteracao
            </SubmitButton>
          </div>
        </form>
      </details>

      <form action={cancelarAdiantamentoAction}>
        <input type="hidden" name="entry_id" value={entry.id} />
        <input type="hidden" name="reservation_id" value={reservationId} />
        <SubmitButton
          variant="perigo"
          confirm={`Cancelar o agendamento de ${money(entry.amount_cents)}? O historico fica registrado.`}
          className="px-3 py-1.5 text-xs"
        >
          Cancelar agendamento
        </SubmitButton>
      </form>
    </div>
  );
}
