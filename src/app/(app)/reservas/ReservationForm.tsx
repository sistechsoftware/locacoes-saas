"use client";
import Link from "next/link";
import RouteEstimate from "@/components/RouteEstimate";
import { useActionState, useEffect, useMemo, useRef, useState, useTransition } from "react";
import ItemsEditor, { subtotalLinha, type ItemRow, type Product, type StockInfo } from "@/components/ItemsEditor";
import ConflictList from "@/components/ConflictList";
import { Field, Grid, Alerta } from "@/components/ui";
import { SubmitButton } from "@/components/SubmitButton";
import { diasCobrados, money, parseMoney } from "@/lib/format";
import { calcularExtensao, rotuloExtensao, type ExtensaoResultado } from "@/lib/hora-extra";
import { descontoDePct, exprDePct, pctDeExpr, pctDigitado, rotuloDesconto, type ModoDesconto } from "@/lib/desconto";
import { sugerirJanelaEvento } from "@/lib/availability-time";
import { PAYMENT_METHODS, PAYMENT_METHOD_LABEL, RESERVATION_STATUS } from "@/lib/domain";
import { statusReserva } from "@/lib/operacao";
import { unicosPorId, type OpcaoSelecionavel } from "@/lib/search-select-utils";
import SearchableSelect from "@/components/SearchableSelect";
import { checkStock } from "./actions";
import { useStockCheck } from "@/components/useStockCheck";
import PreparationChoice from "@/components/PreparationChoice";
import { OPERACAO_PADRAO, ROTULOS_PADRAO, type OperacaoConfig } from "@/lib/operacao";

type Customer = { id: number; name: string; doc?: string; phone: string; reserva_numeros?: string; address: string; district: string; city: string };
type Action = (prev: string | null, fd: FormData) => Promise<string | null>;

/** Última forma de desconto usada (R$ ou %) — memória entre documentos. */
const CHAVE_DESCTO_MODO = "locacoes:desconto-modo";

export default function ReservationForm({
  action,
  products,
  customers,
  reservation,
  items: initialItems = [],
  isAdmin,
  defaultCustomerId,
  freteInicial,
  submitLabel = "Salvar Reserva",
  preparationMinutes = 0,
  contas = [],
  operacao = OPERACAO_PADRAO,
  extensao,
  fidelidadeCents = 0,
}: {
  action: Action;
  products: Product[];
  customers: Customer[];
  reservation?: any;
  items?: ItemRow[];
  isAdmin: boolean;
  defaultCustomerId?: number;
  /** Preenche o frete quando vem da calculadora. */
  freteInicial?: string;
  submitLabel?: string;
  preparationMinutes?: number;
  /** Contas financeiras ativas, para o adiantamento registrar onde o dinheiro entrou. */
  contas?: { id: number; name: string }[];
  /** Nomenclaturas e visibilidade configuradas pela empresa (Configurações → Operação). */
  operacao?: OperacaoConfig;
  /** Extensão de retirada (hora extra): só na edição, com a janela gravada. */
  extensao?: {
    pickupAnterior: string;
    deliveryAnterior: string;
    precoHoraCents: number;
    limiteHoras: number;
    minutos: number;
    cents: number;
  };
  /**
   * Desconto de fidelidade já somado ao valor gravado (recompensa usada).
   * No modo % ele entra por cima do percentual, para editar a reserva não
   * engolir o benefício já entregue ao cliente.
   */
  fidelidadeCents?: number;
}) {
  const { rotulos, vis } = operacao;
  // status com a nomenclatura da empresa (fim da locação = retirada/devolução)
  const statusReservaCfg = statusReserva(operacao, RESERVATION_STATUS);
  const [error, formAction] = useActionState(action, null);
  const [items, setItems] = useState<ItemRow[]>(initialItems);
  const [customerId, setCustomerId] = useState(String(reservation?.customer_id ?? defaultCustomerId ?? ""));
  const [eventDate, setEventDate] = useState(reservation?.event_date ?? "");
  const [eventTime, setEventTime] = useState(reservation?.event_time ?? "");
  const [deliveryAt, setDeliveryAt] = useState(reservation?.delivery_at ?? "");
  const [pickupAt, setPickupAt] = useState(reservation?.pickup_at ?? "");
  // Campos digitados manualmente deixam de ser preenchidos pela automação.
  const deliveryManual = useRef(false);
  const pickupManual = useRef(false);
  // Evento que veio carregado na tela: na edição, abrir a tela não altera nada;
  // a sugestão só age quando o evento mudar (ou o campo estiver vazio).
  const eventoInicial = useRef({ data: reservation?.event_date ?? "", hora: reservation?.event_time ?? "" });
  const [address, setAddress] = useState(reservation?.address ?? "");
  const [district, setDistrict] = useState(reservation?.district ?? "");
  const [city, setCity] = useState(reservation?.city ?? "");

  const [freight, setFreight] = useState(freteInicial ?? cents(reservation?.freight_cents));
  const [assembly, setAssembly] = useState(cents(reservation?.assembly_cents));
  const [disassembly, setDisassembly] = useState(cents(reservation?.disassembly_cents));
  const [other, setOther] = useState(cents(reservation?.other_cents));
  const [discount, setDiscount] = useState(cents(reservation?.discount_cents));
  // Desconto em R$ ou % (migração 0046): o modo GRAVADO no registro manda;
  // só em documento novo (ou sem desconto) vale a última escolha do operador.
  const exprDesconto = reservation?.discount_expr ?? null;
  const [modoDesconto, setModoDesconto] = useState<ModoDesconto>(pctDeExpr(exprDesconto) !== null ? "percent" : "money");
  const [discountPct, setDiscountPct] = useState(() =>
    pctDeExpr(exprDesconto) !== null ? String(exprDesconto).trim().slice(0, -1) : "",
  );
  useEffect(() => {
    if (reservation && (reservation.discount_cents ?? 0) > 0) return;
    const m = window.localStorage.getItem(CHAVE_DESCTO_MODO);
    if (m === "money" || m === "percent") setModoDesconto(m);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // memória: a próxima criação abre na forma que a pessoa acabou de usar
  useEffect(() => {
    window.localStorage.setItem(CHAVE_DESCTO_MODO, modoDesconto);
  }, [modoDesconto]);

  // adiantamento so se aplica na criacao: numa reserva ja existente ele e
  // gerenciado na tela dela, onde da para editar, confirmar e cancelar sem
  // misturar isso com a edicao geral da reserva
  const [hasAdvance, setHasAdvance] = useState(false);
  const [advanceAmount, setAdvanceAmount] = useState("");
  const [advanceMethod, setAdvanceMethod] = useState("pix");
  const [advanceType, setAdvanceType] = useState<"agora" | "agendado">("agora");
  const [advanceDate, setAdvanceDate] = useState("");

  const [considerPreparation, setConsiderPreparation] = useState(reservation?.stock_consider_preparation !== 0);
  const { conflicts, checking, error: stockError } = useStockCheck(items, deliveryAt, pickupAt, considerPreparation, reservation?.id);
  const [override, setOverride] = useState(false);

  // opcoes da busca dinamica: deduplicadas por id, com CPF, telefone e numeros
  // de reserva do cliente como campos de busca por digitos
  const opcoesCliente: OpcaoSelecionavel[] = useMemo(
    () =>
      unicosPorId(customers, (c) => c.id).map((c) => ({
        value: String(c.id),
        label: c.name,
        digitos: [c.doc ?? "", c.phone ?? "", ...(c.reserva_numeros ?? "").split(",")],
      })),
    [customers],
  );

  // preenche o endereco a partir do cliente quando ainda estiver vazio
  useEffect(() => {
    const c = customers.find((x) => String(x.id) === customerId);
    if (!c) return;
    if (!address) setAddress(c.address ?? "");
    if (!district) setDistrict(c.district ?? "");
    if (!city) setCity(c.city ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerId]);

  // sugere janela de entrega/retirada a partir do evento (data = evento,
  // retirada D+1, horário do evento quando definido), sem sobrescrever
  // edições manuais nem dados já salvos
  useEffect(() => {
    const eventoMudou =
      eventDate !== eventoInicial.current.data || eventTime !== eventoInicial.current.hora;
    const janela = sugerirJanelaEvento({
      eventDate,
      eventTime,
      deliveryAtual: deliveryAt,
      pickupAtual: pickupAt,
      deliveryManual: deliveryManual.current,
      pickupManual: pickupManual.current,
      eventoMudou,
      fallbackEntrega: "08:00",
      fallbackRetirada: "10:00",
    });
    if (janela.deliveryAt !== deliveryAt) setDeliveryAt(janela.deliveryAt);
    if (janela.pickupAt !== pickupAt) setPickupAt(janela.pickupAt);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventDate, eventTime]);

  const stockInfo: StockInfo = useMemo(
    () =>
      Object.fromEntries(
        conflicts.map((c) => [c.product_id, { available: c.available, requested: c.requested, missing: c.missing }]),
      ),
    [conflicts],
  );

  /* Hora extra (extensão de retirada): o que o SERVIDOR vai gravar, espelhado
   * aqui só para o operador ver antes de salvar. Retirada não alterada mostra
   * o valor já gravado; alterada, a prévia da nova extensão. */
  const [previsaoExtensao, setPrevisaoExtensao] = useState<ExtensaoResultado | null>(null);
  useEffect(() => {
    if (!extensao) return;
    const r =
      pickupAt === extensao.pickupAnterior
        ? { minutos: extensao.minutos, horasCobradas: 0, cents: extensao.cents, acimaDoLimite: false }
        : calcularExtensao({
            pickupAnterior: extensao.pickupAnterior,
            pickupNovo: pickupAt,
            deliveryAnterior: extensao.deliveryAnterior,
            deliveryNovo: deliveryAt,
            precoHoraCents: extensao.precoHoraCents,
            limiteHoras: extensao.limiteHoras,
          });
    setPrevisaoExtensao(r.minutos > 0 || r.cents > 0 || r.acimaDoLimite ? r : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickupAt, deliveryAt, extensao]);

  // dias de calendário da janela: multiplicador das linhas 'diaria' na
  // exibição — o servidor recalcula da janela gravada ao salvar
  const dias = diasCobrados(deliveryAt, pickupAt);
  const modoDe = (productId: number) => products.find((p) => p.id === productId)?.pricing_mode;
  const itemsTotal = items.reduce((s, i) => s + subtotalLinha(i, modoDe(i.product_id), dias), 0);
  /* Base do desconto percentual: tudo que é somado antes de descontar
     (produtos + serviços + extensão). Fidelidade entra por cima da base. */
  const baseDesconto =
    itemsTotal +
    parseMoney(freight) +
    parseMoney(assembly) +
    parseMoney(disassembly) +
    parseMoney(other) +
    (previsaoExtensao?.cents ?? 0);
  const pctAtual = modoDesconto === "percent" ? pctDigitado(discountPct) : null;
  const descontoAplicado =
    modoDesconto === "percent" ? descontoDePct(baseDesconto, pctAtual ?? 0) + fidelidadeCents : parseMoney(discount);
  const total = Math.max(0, baseDesconto - descontoAplicado);

  // Trocar a forma preserva o valor na tela: % → R$ mostra o equivalente em
  // reais; R$ → % semeia o percentual correspondente — nada pula no total.
  const trocarModoDesconto = (novo: ModoDesconto) => {
    if (novo === modoDesconto) return;
    if (novo === "percent") {
      const pct = baseDesconto > 0 ? Math.min(100, Math.round((parseMoney(discount) / baseDesconto) * 10000) / 100) : 0;
      setDiscountPct(pct > 0 ? String(pct).replace(".", ",") : "");
    } else {
      setDiscount((descontoAplicado / 100).toFixed(2));
    }
    setModoDesconto(novo);
  };

  return (
    <form action={formAction} className="space-y-4">
      {reservation && <input type="hidden" name="id" value={reservation.id} />}
      <input type="hidden" name="items" value={JSON.stringify(items)} />
      <input type="hidden" name="override" value={override ? "1" : "0"} />
      <input type="hidden" name="freight" value={freight} />
      <input type="hidden" name="assembly" value={assembly} />
      <input type="hidden" name="disassembly" value={disassembly} />
      <input type="hidden" name="other" value={other} />
      <input type="hidden" name="discount" value={(descontoAplicado / 100).toFixed(2)} />
      <input
        type="hidden"
        name="discount_expr"
        value={modoDesconto === "percent" && pctAtual !== null ? exprDePct(pctAtual) ?? "" : ""}
      />

      <section className="cartao p-4">
        <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-stone-500">
          {vis.evento ? "Cliente e Evento" : "Cliente"}
        </h2>
        <div className="space-y-3">
          <Field label="Cliente *">
            <div className="flex gap-2">
              <select
                name="customer_id"
                value={customerId}
                onChange={(e) => setCustomerId(e.target.value)}
                className="campo flex-1"
                required
              >
                <option value="">Selecione…</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <Link
                href="/clientes/novo?next=reserva"
                className="flex items-center rounded-xl border border-nuvem-300 bg-white px-3 text-sm font-semibold"
              >
                Novo
              </Link>
            </div>
            <div className="mt-2">
              <SearchableSelect
                options={opcoesCliente}
                onSelect={setCustomerId}
                label="Buscar cliente por nome, CPF ou número da reserva"
              />
            </div>
          </Field>

          {/*
            Campo de evento oculto pela configuração da empresa: os inputs
            continuam presentes (ocultos) para PRESERVAR o dado na edição e o
            servidor deriva a data do início da locação na criação. Ocultar
            nunca apaga nem invalida o campo interno event_date/event_time.
          */}
          {vis.evento ? (
            <Grid>
              <Field label={`${rotulos.evento} *`}>
                <input
                  name="event_date"
                  type="date"
                  value={eventDate}
                  onChange={(e) => setEventDate(e.target.value)}
                  className="campo"
                  required
                />
              </Field>
              <Field label={rotulos.evento_hora}>
                <input name="event_time" type="time" value={eventTime} onChange={(e) => setEventTime(e.target.value)} className="campo" />
              </Field>
            </Grid>
          ) : (
            <>
              <input type="hidden" name="event_date" value={eventDate} />
              <input type="hidden" name="event_time" value={eventTime} />
            </>
          )}

          {vis.endereco ? (
            <>
              <Field label="Endereço do evento">
                <input name="address" value={address} onChange={(e) => setAddress(e.target.value)} className="campo" />
              </Field>
              <Grid>
                <Field label="Bairro">
                  <input name="district" value={district} onChange={(e) => setDistrict(e.target.value)} className="campo" />
                </Field>
                <Field label="Cidade">
                  <input name="city" value={city} onChange={(e) => setCity(e.target.value)} className="campo" />
                </Field>
              </Grid>
            </>
          ) : (
            /* endereço desabilitado: valores já gravados seguem no submit */
            <>
              <input type="hidden" name="address" value={address} />
              <input type="hidden" name="district" value={district} />
              <input type="hidden" name="city" value={city} />
            </>
          )}
        </div>
      </section>

      {vis.endereco && (
        <RouteEstimate tipo="locacao" destination={[address, district, city].filter(Boolean).join(", ")} onApply={setFreight} />
      )}
      <section className="cartao p-4">
        <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-stone-500">
          {/* título legado mantido enquanto a empresa não personaliza os rótulos */}
          {rotulos.inicio !== ROTULOS_PADRAO.inicio || rotulos.fim !== ROTULOS_PADRAO.fim
            ? "Período da locação"
            : "Entrega e retirada"}
        </h2>
        <Grid>
          <Field label={rotulos.inicio} hint="Define quando o equipamento sai do estoque.">
            <input
              name="delivery_at"
              required
              type="datetime-local"
              value={deliveryAt}
              onChange={(e) => {
                deliveryManual.current = true;
                setDeliveryAt(e.target.value);
              }}
              className="campo"
            />
          </Field>
          <Field label={rotulos.fim} hint="Define quando o equipamento volta ao estoque.">
            <input
              name="pickup_at"
              required
              type="datetime-local"
              value={pickupAt}
              onChange={(e) => {
                pickupManual.current = true;
                setPickupAt(e.target.value);
              }}
              className="campo"
            />
          </Field>
        </Grid>
        {previsaoExtensao && previsaoExtensao.cents > 0 && (
          <p className="mt-2 rounded-xl border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-800">
            Extensão {rotuloExtensao(previsaoExtensao.minutos)}: {money(previsaoExtensao.cents)} — cobrada como linha própria ao salvar.
          </p>
        )}
        {previsaoExtensao && previsaoExtensao.acimaDoLimite && (
          <p className="mt-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-800">
            Retirada estendida {rotuloExtensao(previsaoExtensao.minutos)} (limite configurado: {extensao?.limiteHoras}h). Nada é cobrado automaticamente — revise os itens se precisar cobrar uma diária adicional.
          </p>
        )}
        <PreparationChoice value={considerPreparation} onChange={setConsiderPreparation} minutes={preparationMinutes} from={deliveryAt} to={pickupAt} />
        {stockError && <Alerta tone="ambar">{stockError}</Alerta>}
        {/* montagem/desmontagem ocultas: os flags já gravados seguem no
            submit via hidden input — ocultar nunca zera um dado salvo */}
        {!vis.montagem && reservation?.needs_assembly ? <input type="hidden" name="needs_assembly" value="1" /> : null}
        {!vis.montagem && reservation?.needs_disassembly ? <input type="hidden" name="needs_disassembly" value="1" /> : null}
        <div className="mt-3 grid grid-cols-2 gap-2">
          {([
            ["needs_delivery", rotulos.operacao_inicio, reservation ? !!reservation.needs_delivery : true],
            ["needs_pickup", rotulos.operacao_fim, reservation ? !!reservation.needs_pickup : true],
            ...(vis.montagem
              ? [
                  ["needs_assembly", "Montagem", reservation ? !!reservation.needs_assembly : false],
                  ["needs_disassembly", "Desmontagem", reservation ? !!reservation.needs_disassembly : false],
                ]
              : []),
          ] as [string, string, boolean][]).map(([name, label, checked]) => (
            <label
              key={name as string}
              className="flex items-center gap-2 rounded-xl border border-nuvem-300 bg-white px-3 py-2.5 text-sm font-medium"
            >
              <input type="checkbox" name={name} defaultChecked={checked} className="h-4 w-4" />
              {label}
            </label>
          ))}
        </div>
      </section>

      <section className="cartao p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-bold uppercase tracking-wide text-stone-500">Itens</h2>
          {checking && <span className="text-xs text-stone-400">Verificando estoque…</span>}
        </div>

        {conflicts.length > 0 && (
          <div className="mb-3">
            <Alerta tone="vermelho" title="Estoque insuficiente nesta data">
              <ConflictList conflicts={conflicts} />
              {isAdmin ? (
                <label className="mt-2 flex items-center gap-2 text-xs font-semibold">
                  <input
                    type="checkbox"
                    checked={override}
                    onChange={(e) => setOverride(e.target.checked)}
                    className="h-4 w-4"
                  />
                  Autorizar mesmo assim (administrador)
                </label>
              ) : (
                <p className="mt-2 text-xs font-semibold">
                  Ajuste as quantidades ou peça autorização ao administrador.
                </p>
              )}
            </Alerta>
          </div>
        )}

        <ItemsEditor products={products} items={items} onChange={setItems} stock={stockInfo} dataReferencia={eventDate || deliveryAt.slice(0, 10)} dias={dias} />
      </section>

      <section className="cartao p-4">
        <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-stone-500">Serviços e Valores</h2>
        <Grid>
          <Field label="Frete (R$)">
            <input value={freight} onChange={(e) => setFreight(e.target.value)} inputMode="decimal" className="campo" />
          </Field>
          {/* montagem/desmontagem desabilitadas: os valores já lançados
              continuam no estado (e no hidden input "assembly"/
              "disassembly" do topo) — só a edição some da tela */}
          {vis.montagem && (
            <Field label="Montagem (R$)">
              <input value={assembly} onChange={(e) => setAssembly(e.target.value)} inputMode="decimal" className="campo" />
            </Field>
          )}
          {vis.montagem && (
            <Field label="Desmontagem (R$)">
              <input
                value={disassembly}
                onChange={(e) => setDisassembly(e.target.value)}
                inputMode="decimal"
                className="campo"
              />
            </Field>
          )}
          <Field label="Outros serviços (R$)">
            <input value={other} onChange={(e) => setOther(e.target.value)} inputMode="decimal" className="campo" />
          </Field>
          <Field label={modoDesconto === "percent" ? "Desconto (%)" : "Desconto (R$)"}>
            <div className="flex gap-2">
              <input
                value={modoDesconto === "percent" ? discountPct : discount}
                onChange={(e) => (modoDesconto === "percent" ? setDiscountPct(e.target.value) : setDiscount(e.target.value))}
                inputMode="decimal"
                placeholder={modoDesconto === "percent" ? "ex.: 10" : "ex.: 150,00"}
                className="campo flex-1"
              />
              <div className="flex shrink-0 self-start overflow-hidden rounded-xl border border-nuvem-300">
                <button
                  type="button"
                  onClick={() => trocarModoDesconto("money")}
                  className={`px-3 py-2 text-xs font-bold ${modoDesconto === "money" ? "bg-marca-600 text-white" : "bg-white text-stone-500"}`}
                >
                  R$
                </button>
                <button
                  type="button"
                  onClick={() => trocarModoDesconto("percent")}
                  className={`px-3 py-2 text-xs font-bold ${modoDesconto === "percent" ? "bg-marca-600 text-white" : "bg-white text-stone-500"}`}
                >
                  %
                </button>
              </div>
            </div>
          </Field>
          {/* caução desabilitada: o valor já gravado da reserva segue no
              submit via hidden input — a desativação nunca zera a caução */}
          {vis.caucao ? (
            <Field label="Caução (R$)" hint="Valor separado da locação.">
              <input
                name="deposit"
                defaultValue={cents(reservation?.deposit_cents)}
                inputMode="decimal"
                className="campo"
              />
            </Field>
          ) : (
            <input type="hidden" name="deposit" value={cents(reservation?.deposit_cents)} />
          )}
        </Grid>

        <div className="mt-3 space-y-1 rounded-xl bg-nuvem-100 p-3 text-sm">
          <Linha label="Produtos" value={money(itemsTotal)} />
          <Linha label="Frete" value={money(parseMoney(freight))} />
          {/* linha some só quando desabilitada E sem valor — valor lançado
              continua visível para o total fechar com o que foi cobrado */}
          {(vis.montagem || parseMoney(assembly) > 0) && <Linha label="Montagem" value={money(parseMoney(assembly))} />}
          {(vis.montagem || parseMoney(disassembly) > 0) && <Linha label="Desmontagem" value={money(parseMoney(disassembly))} />}
          <Linha label="Outros" value={money(parseMoney(other))} />
          {previsaoExtensao && previsaoExtensao.cents > 0 && (
            <Linha label={`Extensão ${rotuloExtensao(previsaoExtensao.minutos)}`} value={money(previsaoExtensao.cents)} />
          )}
          <Linha
            label="Desconto"
            value={
              "- " + rotuloDesconto(descontoAplicado, modoDesconto === "percent" && pctAtual !== null ? exprDePct(pctAtual) : null)
            }
          />
          <div className="flex items-center justify-between border-t border-nuvem-300 pt-2 text-base font-bold">
            <span>Total da reserva</span>
            <span>{money(total)}</span>
          </div>
        </div>
      </section>

      {!reservation && (
        <section className="cartao p-4">
          <label className="flex items-center gap-2 text-sm font-bold text-tinta-900">
            <input
              type="checkbox"
              checked={hasAdvance}
              onChange={(e) => setHasAdvance(e.target.checked)}
              className="h-4 w-4"
            />
            Possui adiantamento
          </label>
          <input type="hidden" name="advance_has" value={hasAdvance ? "1" : "0"} />

          {hasAdvance && (
            <div className="mt-3 space-y-3">
              <Grid>
                <Field label="Valor do adiantamento (R$)">
                  <input
                    name="advance_amount"
                    value={advanceAmount}
                    onChange={(e) => setAdvanceAmount(e.target.value)}
                    inputMode="decimal"
                    className="campo"
                  />
                </Field>
                <Field label="Forma de pagamento">
                  <select
                    name="advance_method"
                    value={advanceMethod}
                    onChange={(e) => setAdvanceMethod(e.target.value)}
                    className="campo"
                  >
                    {PAYMENT_METHODS.map((m) => (
                      <option key={m} value={m}>
                        {PAYMENT_METHOD_LABEL[m]}
                      </option>
                    ))}
                  </select>
                </Field>
              </Grid>

              <div className="flex flex-col gap-2 sm:flex-row">
                <label
                  className={`flex flex-1 cursor-pointer items-center gap-2 rounded-xl border p-3 text-sm ${
                    advanceType === "agora" ? "border-marca-400 bg-marca-50" : "border-nuvem-300"
                  }`}
                >
                  <input
                    type="radio"
                    name="advance_type"
                    value="agora"
                    checked={advanceType === "agora"}
                    onChange={() => setAdvanceType("agora")}
                  />
                  <span>
                    <span className="block font-semibold text-tinta-900">Pago agora</span>
                    <span className="block text-xs text-stone-500">Entra como recebido, abate do saldo na hora.</span>
                  </span>
                </label>
                <label
                  className={`flex flex-1 cursor-pointer items-center gap-2 rounded-xl border p-3 text-sm ${
                    advanceType === "agendado" ? "border-marca-400 bg-marca-50" : "border-nuvem-300"
                  }`}
                >
                  <input
                    type="radio"
                    name="advance_type"
                    value="agendado"
                    checked={advanceType === "agendado"}
                    onChange={() => setAdvanceType("agendado")}
                  />
                  <span>
                    <span className="block font-semibold text-tinta-900">Agendar pagamento</span>
                    <span className="block text-xs text-stone-500">Fica como previsto até confirmar o recebimento.</span>
                  </span>
                </label>
              </div>

              {advanceType === "agendado" && (
                <Field label="Data prevista">
                  <input
                    name="advance_date"
                    type="date"
                    value={advanceDate}
                    onChange={(e) => setAdvanceDate(e.target.value)}
                    className="campo max-w-56"
                  />
                </Field>
              )}

              <Field label="Conta Corrente">
                <select
                  name="advance_account_id"
                  defaultValue={contas.length === 1 ? String(contas[0].id) : ""}
                  className="campo max-w-56"
                >
                  <option value="">Sem conta</option>
                  {contas.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </Field>

              <div className="rounded-xl bg-nuvem-100 p-3 text-sm">
                {advanceType === "agora" ? (
                  <>
                    <Linha label="Adiantamento recebido" value={money(parseMoney(advanceAmount))} />
                    <div className="flex items-center justify-between pt-1 text-sm font-bold">
                      <span>Saldo restante</span>
                      <span>{money(Math.max(0, total - parseMoney(advanceAmount)))}</span>
                    </div>
                  </>
                ) : (
                  <>
                    <Linha label="Adiantamento agendado (a receber)" value={money(parseMoney(advanceAmount))} />
                    <p className="pt-1 text-xs text-stone-500">
                      Nada é descontado do saldo até o recebimento ser confirmado.
                    </p>
                  </>
                )}
              </div>
            </div>
          )}
        </section>
      )}

      <section className="cartao p-4">
        <Grid>
          <Field label="Status">
            <select name="status" defaultValue={reservation?.status ?? "pre_reserva"} className="campo">
              {statusReservaCfg.filter((s) => s.value !== "orcamento").map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Observações">
            <input name="notes" defaultValue={reservation?.notes ?? ""} className="campo" />
          </Field>
        </Grid>
      </section>

      {error && (
        <p className="rounded-xl border border-red-300 bg-red-50 px-3 py-2.5 text-sm font-medium text-red-700">
          {error}
        </p>
      )}

      <div className="sticky bottom-20 z-10 md:bottom-4">
        <SubmitButton className="w-full py-3 text-base shadow-lg">{submitLabel}</SubmitButton>
      </div>
    </form>
  );
}

function Linha({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between text-stone-600">
      <span>{label}</span>
      <span className="font-medium text-tinta-900">{value}</span>
    </div>
  );
}

const cents = (v: number | undefined) => ((v ?? 0) / 100).toFixed(2);
