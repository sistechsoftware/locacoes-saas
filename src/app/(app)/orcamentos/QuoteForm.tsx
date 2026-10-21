"use client";
import Link from "next/link";
import RouteEstimate from "@/components/RouteEstimate";
import { useActionState, useEffect, useMemo, useRef, useState, useTransition } from "react";
import ItemsEditor, { subtotalLinha, type ItemRow, type Product, type StockInfo } from "@/components/ItemsEditor";
import ConflictList from "@/components/ConflictList";
import { Alerta, Field, Grid } from "@/components/ui";
import { SubmitButton } from "@/components/SubmitButton";
import { diasCobrados, money, parseMoney } from "@/lib/format";
import { calcularExtensao, rotuloExtensao, type ExtensaoResultado } from "@/lib/hora-extra";
import { descontoDePct, exprDePct, pctDeExpr, pctDigitado, rotuloDesconto, type ModoDesconto } from "@/lib/desconto";
import { sugerirJanelaEvento } from "@/lib/availability-time";
import { QUOTE_STATUS } from "@/lib/domain";
import { unicosPorId, type OpcaoSelecionavel } from "@/lib/search-select-utils";
import SearchableSelect from "@/components/SearchableSelect";
import { checkStock } from "../reservas/actions";
import { useStockCheck } from "@/components/useStockCheck";
import PreparationChoice from "@/components/PreparationChoice";
import { OPERACAO_PADRAO, rotuloOu, type OperacaoConfig } from "@/lib/operacao";

type Customer = { id: number; name: string; doc?: string; phone?: string; reserva_numeros?: string; address: string; district: string; city: string };
type Action = (prev: string | null, fd: FormData) => Promise<string | null>;

/** Última forma de desconto usada (R$ ou %) — memória entre documentos. */
const CHAVE_DESCTO_MODO = "locacoes:desconto-modo";

export default function QuoteForm({
  action,
  products,
  customers,
  quote,
  items: initialItems = [],
  defaultCustomerId,
  submitLabel = "Salvar Orçamento",
  preparationMinutes = 0,
  operacao = OPERACAO_PADRAO,
  extensao,
}: {
  action: Action;
  products: Product[];
  customers: Customer[];
  quote?: any;
  items?: ItemRow[];
  defaultCustomerId?: number;
  submitLabel?: string;
  preparationMinutes?: number;
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
}) {
  const { rotulos, vis } = operacao;
  const [error, formAction] = useActionState(action, null);
  const [items, setItems] = useState<ItemRow[]>(initialItems);
  const [customerId, setCustomerId] = useState(String(quote?.customer_id ?? defaultCustomerId ?? ""));
  const [eventDate, setEventDate] = useState(quote?.event_date ?? "");
  const [eventTime, setEventTime] = useState(quote?.event_time ?? "");
  const [deliveryAt, setDeliveryAt] = useState(quote?.delivery_at ?? "");
  const [pickupAt, setPickupAt] = useState(quote?.pickup_at ?? "");
  // Campos digitados manualmente deixam de ser preenchidos pela automação.
  const deliveryManual = useRef(false);
  const pickupManual = useRef(false);
  // Evento que veio carregado na tela: na edição, abrir a tela não altera nada;
  // a sugestão só age quando o evento mudar (ou o campo estiver vazio).
  const eventoInicial = useRef({ data: quote?.event_date ?? "", hora: quote?.event_time ?? "" });
  const [considerPreparation, setConsiderPreparation] = useState(quote?.stock_consider_preparation !== 0);
  const [address, setAddress] = useState(quote?.address ?? "");
  const [district, setDistrict] = useState(quote?.district ?? "");
  const [city, setCity] = useState(quote?.city ?? "");
  const [freight, setFreight] = useState(cents(quote?.freight_cents));
  const [assembly, setAssembly] = useState(cents(quote?.assembly_cents));
  const [disassembly, setDisassembly] = useState(cents(quote?.disassembly_cents));
  const [other, setOther] = useState(cents(quote?.other_cents));
  const [discount, setDiscount] = useState(cents(quote?.discount_cents));
  // Desconto em R$ ou % (migração 0046): o modo GRAVADO no registro manda;
  // só em documento novo (ou sem desconto) vale a última escolha do operador.
  const exprDesconto = quote?.discount_expr ?? null;
  const [modoDesconto, setModoDesconto] = useState<ModoDesconto>(pctDeExpr(exprDesconto) !== null ? "percent" : "money");
  const [discountPct, setDiscountPct] = useState(() =>
    pctDeExpr(exprDesconto) !== null ? String(exprDesconto).trim().slice(0, -1) : "",
  );
  useEffect(() => {
    if (quote && (quote.discount_cents ?? 0) > 0) return;
    const m = window.localStorage.getItem(CHAVE_DESCTO_MODO);
    if (m === "money" || m === "percent") setModoDesconto(m);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // memória: o próximo orçamento abre na forma que a pessoa acabou de usar
  useEffect(() => {
    window.localStorage.setItem(CHAVE_DESCTO_MODO, modoDesconto);
  }, [modoDesconto]);
  const { conflicts, checking, error: stockError } = useStockCheck(items, deliveryAt, pickupAt, considerPreparation);

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
      fallbackRetirada: "18:00",
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
  // Base do desconto percentual: tudo que é somado antes de descontar.
  const baseDesconto =
    itemsTotal + parseMoney(freight) + parseMoney(assembly) + parseMoney(disassembly) + parseMoney(other) + (previsaoExtensao?.cents ?? 0);
  const pctAtual = modoDesconto === "percent" ? pctDigitado(discountPct) : null;
  const descontoAplicado = modoDesconto === "percent" ? descontoDePct(baseDesconto, pctAtual ?? 0) : parseMoney(discount);
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
      {quote && <input type="hidden" name="id" value={quote.id} />}
      <input type="hidden" name="items" value={JSON.stringify(items)} />
      <input type="hidden" name="freight" value={freight} />
      {vis.endereco && (
        <RouteEstimate tipo="locacao" destination={[address,district,city].filter(Boolean).join(", ")} onApply={setFreight}/>
      )}
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
                href="/clientes/novo"
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
          {/* campo de evento oculto pela configuração da empresa: os inputs
              ocultos preservam o dado gravado; na criação o servidor deriva a
              data do início da locação. Ocultar nunca apaga o campo interno. */}
          {vis.evento && (
            <Grid>
              <Field label={rotulos.evento}>
                <input
                  name="event_date"
                  type="date"
                  value={eventDate}
                  onChange={(e) => setEventDate(e.target.value)}
                  className="campo"
                />
              </Field>
              <Field label={rotuloOu(operacao, "evento_hora", "Horário")}>
                <input name="event_time" type="time" value={eventTime} onChange={(e) => setEventTime(e.target.value)} className="campo" />
              </Field>
            </Grid>
          )}
          {!vis.evento && (
            <>
              <input type="hidden" name="event_date" value={eventDate} />
              <input type="hidden" name="event_time" value={eventTime} />
            </>
          )}
          <Grid>
            <Field label={rotuloOu(operacao, "inicio", "Entrega prevista")}>
              <input
                name="delivery_at"
                type="datetime-local"
                required value={deliveryAt} onChange={(e) => {
                  deliveryManual.current = true;
                  setDeliveryAt(e.target.value);
                }}
                className="campo"
              />
            </Field>
            <Field label={rotuloOu(operacao, "fim", "Retirada prevista")}>
              <input required name="pickup_at" type="datetime-local" value={pickupAt} onChange={(e) => {
              pickupManual.current = true;
              setPickupAt(e.target.value);
            }} className="campo" />
            </Field>
          </Grid>
          {previsaoExtensao && previsaoExtensao.cents > 0 && (
            <p className="rounded-xl border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-800">
              Extensão {rotuloExtensao(previsaoExtensao.minutos)}: {money(previsaoExtensao.cents)} — cobrada como linha própria ao salvar.
            </p>
          )}
          {previsaoExtensao && previsaoExtensao.acimaDoLimite && (
            <p className="rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-800">
              Retirada estendida {rotuloExtensao(previsaoExtensao.minutos)} (limite configurado: {extensao?.limiteHoras}h). Nada é cobrado automaticamente — revise os itens se precisar cobrar uma diária adicional.
            </p>
          )}
          {vis.endereco ? (
            <>
              <Field label="Endereço">
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

      <section className="cartao p-4">
        <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-stone-500">Itens</h2>
        <PreparationChoice value={considerPreparation} onChange={setConsiderPreparation} minutes={preparationMinutes} from={deliveryAt} to={pickupAt} />
        {checking && <p className="text-xs text-stone-500">Verificando estoque…</p>}
        {stockError && <Alerta tone="ambar">{stockError}</Alerta>}
        {conflicts.length > 0 && (
          <div className="mb-3">
            <Alerta tone="ambar" title="Atenção: estoque apertado neste intervalo">
              <ConflictList conflicts={conflicts} />
              <p className="mt-1 text-xs">
                O orçamento pode ser salvo assim mesmo. A checagem será refeita na conversão em reserva.
              </p>
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
              permanecem nos hidden inputs do topo — só a edição some */}
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
          <Field label="Outros (R$)">
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
          <Field label="Válido até">
            <input name="valid_until" type="date" defaultValue={quote?.valid_until ?? ""} className="campo" />
          </Field>
          <Field label="Status">
            <select name="status" defaultValue={quote?.status ?? "rascunho"} className="campo">
              {QUOTE_STATUS.filter((s) => s.value !== "convertido").map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Observações">
            <input name="notes" defaultValue={quote?.notes ?? ""} className="campo" />
          </Field>
        </Grid>

        <div className="mt-3 space-y-1 rounded-xl bg-nuvem-100 px-3 py-3 text-sm">
          {previsaoExtensao && previsaoExtensao.cents > 0 && (
            <div className="flex items-center justify-between text-stone-600">
              <span>Extensão {rotuloExtensao(previsaoExtensao.minutos)}</span>
              <span className="font-medium text-tinta-900">{money(previsaoExtensao.cents)}</span>
            </div>
          )}
          <div className="flex items-center justify-between text-base font-bold">
            <span>Total do Orçamento</span>
            <span>{money(total)}</span>
          </div>
        </div>
      </section>

      {error && (
        <p className="rounded-xl border border-red-300 bg-red-50 px-3 py-2.5 text-sm font-medium text-red-700">{error}</p>
      )}
      <div className="sticky bottom-20 z-10 md:bottom-4">
        <SubmitButton className="w-full py-3 text-base shadow-lg">{submitLabel}</SubmitButton>
      </div>
    </form>
  );
}

const cents = (v: number | undefined) => ((v ?? 0) / 100).toFixed(2);
