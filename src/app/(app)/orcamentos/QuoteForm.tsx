"use client";
import Link from "next/link";
import RouteEstimate from "@/components/RouteEstimate";
import { useActionState, useEffect, useMemo, useState, useTransition } from "react";
import ItemsEditor, { type ItemRow, type Product, type StockInfo } from "@/components/ItemsEditor";
import ConflictList from "@/components/ConflictList";
import { Alerta, Field, Grid } from "@/components/ui";
import { SubmitButton } from "@/components/SubmitButton";
import { money, parseMoney } from "@/lib/format";
import { QUOTE_STATUS } from "@/lib/domain";
import { unicosPorId, type OpcaoSelecionavel } from "@/lib/search-select-utils";
import SearchableSelect from "@/components/SearchableSelect";
import { checkStock } from "../reservas/actions";
import { useStockCheck } from "@/components/useStockCheck";
import PreparationChoice from "@/components/PreparationChoice";

type Customer = { id: number; name: string; doc?: string; phone?: string; reserva_numeros?: string; address: string; district: string; city: string };
type Action = (prev: string | null, fd: FormData) => Promise<string | null>;

export default function QuoteForm({
  action,
  products,
  customers,
  quote,
  items: initialItems = [],
  defaultCustomerId,
  submitLabel = "Salvar Orçamento",
  preparationMinutes = 0,
}: {
  action: Action;
  products: Product[];
  customers: Customer[];
  quote?: any;
  items?: ItemRow[];
  defaultCustomerId?: number;
  submitLabel?: string;
  preparationMinutes?: number;
}) {
  const [error, formAction] = useActionState(action, null);
  const [items, setItems] = useState<ItemRow[]>(initialItems);
  const [customerId, setCustomerId] = useState(String(quote?.customer_id ?? defaultCustomerId ?? ""));
  const [eventDate, setEventDate] = useState(quote?.event_date ?? "");
  const [deliveryAt, setDeliveryAt] = useState(quote?.delivery_at ?? "");
  const [pickupAt, setPickupAt] = useState(quote?.pickup_at ?? "");
  const [considerPreparation, setConsiderPreparation] = useState(quote?.stock_consider_preparation !== 0);
  const [address, setAddress] = useState(quote?.address ?? "");
  const [district, setDistrict] = useState(quote?.district ?? "");
  const [city, setCity] = useState(quote?.city ?? "");
  const [freight, setFreight] = useState(cents(quote?.freight_cents));
  const [assembly, setAssembly] = useState(cents(quote?.assembly_cents));
  const [disassembly, setDisassembly] = useState(cents(quote?.disassembly_cents));
  const [other, setOther] = useState(cents(quote?.other_cents));
  const [discount, setDiscount] = useState(cents(quote?.discount_cents));
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

  useEffect(() => {
    if (!eventDate) return;
    if (!deliveryAt) setDeliveryAt(`${eventDate}T08:00`);
    if (!pickupAt) setPickupAt(`${eventDate}T18:00`);
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
    itemsTotal + parseMoney(freight) + parseMoney(assembly) + parseMoney(disassembly) + parseMoney(other) - parseMoney(discount),
  );

  return (
    <form action={formAction} className="space-y-4">
      {quote && <input type="hidden" name="id" value={quote.id} />}
      <input type="hidden" name="items" value={JSON.stringify(items)} />
      <input type="hidden" name="freight" value={freight} />
      <RouteEstimate tipo="locacao" destination={[address,district,city].filter(Boolean).join(", ")} onApply={setFreight}/>
      <input type="hidden" name="assembly" value={assembly} />
      <input type="hidden" name="disassembly" value={disassembly} />
      <input type="hidden" name="other" value={other} />
      <input type="hidden" name="discount" value={discount} />

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
          <Grid>
            <Field label="Data do evento">
              <input
                name="event_date"
                type="date"
                value={eventDate}
                onChange={(e) => setEventDate(e.target.value)}
                className="campo"
              />
            </Field>
            <Field label="Horário">
              <input name="event_time" type="time" defaultValue={quote?.event_time ?? ""} className="campo" />
            </Field>
            <Field label="Entrega prevista">
              <input
                name="delivery_at"
                type="datetime-local"
                required value={deliveryAt} onChange={(e) => setDeliveryAt(e.target.value)}
                className="campo"
              />
            </Field>
            <Field label="Retirada prevista">
              <input required name="pickup_at" type="datetime-local" value={pickupAt} onChange={(e) => setPickupAt(e.target.value)} className="campo" />
            </Field>
          </Grid>
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
          <Field label="Outros (R$)">
            <input value={other} onChange={(e) => setOther(e.target.value)} inputMode="decimal" className="campo" />
          </Field>
          <Field label="Desconto (R$)">
            <input value={discount} onChange={(e) => setDiscount(e.target.value)} inputMode="decimal" className="campo" />
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

        <div className="mt-3 flex items-center justify-between rounded-xl bg-nuvem-100 px-3 py-3 text-base font-bold">
          <span>Total do Orçamento</span>
          <span>{money(total)}</span>
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
