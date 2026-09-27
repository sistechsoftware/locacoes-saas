"use client";
import Link from "next/link";
import RouteEstimate from "@/components/RouteEstimate";
import { useActionState, useEffect, useMemo, useState, useTransition } from "react";
import ItemsEditor, { type ItemRow, type Product, type StockInfo } from "@/components/ItemsEditor";
import ConflictList from "@/components/ConflictList";
import { Field, Grid, Alerta } from "@/components/ui";
import { SubmitButton } from "@/components/SubmitButton";
import { money, parseMoney } from "@/lib/format";
import { PAYMENT_METHODS, PAYMENT_METHOD_LABEL, RESERVATION_STATUS } from "@/lib/domain";
import { unicosPorId, type OpcaoSelecionavel } from "@/lib/search-select-utils";
import SearchableSelect from "@/components/SearchableSelect";
import { checkStock } from "./actions";
import { useStockCheck } from "@/components/useStockCheck";
import PreparationChoice from "@/components/PreparationChoice";

type Customer = { id: number; name: string; doc?: string; phone: string; reserva_numeros?: string; address: string; district: string; city: string };
type Action = (prev: string | null, fd: FormData) => Promise<string | null>;

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
}) {
  const [error, formAction] = useActionState(action, null);
  const [items, setItems] = useState<ItemRow[]>(initialItems);
  const [customerId, setCustomerId] = useState(String(reservation?.customer_id ?? defaultCustomerId ?? ""));
  const [eventDate, setEventDate] = useState(reservation?.event_date ?? "");
  const [deliveryAt, setDeliveryAt] = useState(reservation?.delivery_at ?? "");
  const [pickupAt, setPickupAt] = useState(reservation?.pickup_at ?? "");
  const [address, setAddress] = useState(reservation?.address ?? "");
  const [district, setDistrict] = useState(reservation?.district ?? "");
  const [city, setCity] = useState(reservation?.city ?? "");

  const [freight, setFreight] = useState(freteInicial ?? cents(reservation?.freight_cents));
  const [assembly, setAssembly] = useState(cents(reservation?.assembly_cents));
  const [disassembly, setDisassembly] = useState(cents(reservation?.disassembly_cents));
  const [other, setOther] = useState(cents(reservation?.other_cents));
  const [discount, setDiscount] = useState(cents(reservation?.discount_cents));

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

  // sugere janela de entrega/retirada a partir da data do evento
  useEffect(() => {
    if (!eventDate) return;
    if (!deliveryAt) setDeliveryAt(`${eventDate}T08:00`);
    if (!pickupAt) setPickupAt(`${nextDay(eventDate)}T10:00`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventDate]);

  const stockInfo: StockInfo = useMemo(
    () =>
      Object.fromEntries(
        conflicts.map((c) => [c.product_id, { available: c.available, requested: c.requested, missing: c.missing }]),
      ),
    [conflicts],
  );

  const itemsTotal = items.reduce((s, i) => s + Math.max(0, i.qty * i.unit_price_cents - i.discount_cents), 0);
  const total = Math.max(
    0,
    itemsTotal +
      parseMoney(freight) +
      parseMoney(assembly) +
      parseMoney(disassembly) +
      parseMoney(other) -
      parseMoney(discount),
  );

  return (
    <form action={formAction} className="space-y-4">
      {reservation && <input type="hidden" name="id" value={reservation.id} />}
      <input type="hidden" name="items" value={JSON.stringify(items)} />
      <input type="hidden" name="override" value={override ? "1" : "0"} />
      <input type="hidden" name="freight" value={freight} />
      <input type="hidden" name="assembly" value={assembly} />
      <input type="hidden" name="disassembly" value={disassembly} />
      <input type="hidden" name="other" value={other} />
      <input type="hidden" name="discount" value={discount} />

      <section className="cartao p-4">
        <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-stone-500">Cliente e Evento</h2>
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

          <Grid>
            <Field label="Data do evento *">
              <input
                name="event_date"
                type="date"
                value={eventDate}
                onChange={(e) => setEventDate(e.target.value)}
                className="campo"
                required
              />
            </Field>
            <Field label="Horário do evento">
              <input name="event_time" type="time" defaultValue={reservation?.event_time ?? ""} className="campo" />
            </Field>
          </Grid>

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
        </div>
      </section>

      <RouteEstimate tipo="locacao" destination={[address, district, city].filter(Boolean).join(", ")} onApply={setFreight} />
      <section className="cartao p-4">
        <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-stone-500">Entrega e retirada</h2>
        <Grid>
          <Field label="Entrega em" hint="Define quando o equipamento sai do estoque.">
            <input
              name="delivery_at"
              required
              type="datetime-local"
              value={deliveryAt}
              onChange={(e) => setDeliveryAt(e.target.value)}
              className="campo"
            />
          </Field>
          <Field label="Retirada em" hint="Define quando o equipamento volta ao estoque.">
            <input
              name="pickup_at"
              required
              type="datetime-local"
              value={pickupAt}
              onChange={(e) => setPickupAt(e.target.value)}
              className="campo"
            />
          </Field>
        </Grid>
        <PreparationChoice value={considerPreparation} onChange={setConsiderPreparation} minutes={preparationMinutes} from={deliveryAt} to={pickupAt} />
        {stockError && <Alerta tone="ambar">{stockError}</Alerta>}
        <div className="mt-3 grid grid-cols-2 gap-2">
          {[
            ["needs_delivery", "Entrega", reservation ? !!reservation.needs_delivery : true],
            ["needs_pickup", "Retirada", reservation ? !!reservation.needs_pickup : true],
            ["needs_assembly", "Montagem", reservation ? !!reservation.needs_assembly : false],
            ["needs_disassembly", "Desmontagem", reservation ? !!reservation.needs_disassembly : false],
          ].map(([name, label, checked]) => (
            <label
              key={name as string}
              className="flex items-center gap-2 rounded-xl border border-nuvem-300 bg-white px-3 py-2.5 text-sm font-medium"
            >
              <input type="checkbox" name={name as string} defaultChecked={checked as boolean} className="h-4 w-4" />
              {label as string}
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

        <ItemsEditor products={products} items={items} onChange={setItems} stock={stockInfo} dataReferencia={eventDate} />
      </section>

      <section className="cartao p-4">
        <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-stone-500">Serviços e Valores</h2>
        <Grid>
          <Field label="Frete (R$)">
            <input value={freight} onChange={(e) => setFreight(e.target.value)} inputMode="decimal" className="campo" />
          </Field>
          <Field label="Montagem (R$)">
            <input value={assembly} onChange={(e) => setAssembly(e.target.value)} inputMode="decimal" className="campo" />
          </Field>
          <Field label="Desmontagem (R$)">
            <input
              value={disassembly}
              onChange={(e) => setDisassembly(e.target.value)}
              inputMode="decimal"
              className="campo"
            />
          </Field>
          <Field label="Outros serviços (R$)">
            <input value={other} onChange={(e) => setOther(e.target.value)} inputMode="decimal" className="campo" />
          </Field>
          <Field label="Desconto (R$)">
            <input value={discount} onChange={(e) => setDiscount(e.target.value)} inputMode="decimal" className="campo" />
          </Field>
          <Field label="Caução (R$)" hint="Valor separado da locação.">
            <input
              name="deposit"
              defaultValue={cents(reservation?.deposit_cents)}
              inputMode="decimal"
              className="campo"
            />
          </Field>
        </Grid>

        <div className="mt-3 space-y-1 rounded-xl bg-nuvem-100 p-3 text-sm">
          <Linha label="Produtos" value={money(itemsTotal)} />
          <Linha label="Frete" value={money(parseMoney(freight))} />
          <Linha label="Montagem" value={money(parseMoney(assembly))} />
          <Linha label="Desmontagem" value={money(parseMoney(disassembly))} />
          <Linha label="Outros" value={money(parseMoney(other))} />
          <Linha label="Desconto" value={"- " + money(parseMoney(discount))} />
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
              {RESERVATION_STATUS.filter((s) => s.value !== "orcamento").map((s) => (
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

function nextDay(dateISO: string) {
  const d = new Date(dateISO + "T12:00");
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}
