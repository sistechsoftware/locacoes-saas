"use client";
import { useActionState, useMemo, useState } from "react";
import RouteEstimate from "@/components/RouteEstimate";
import { Field, Grid } from "@/components/ui";
import { SubmitButton } from "@/components/SubmitButton";
import { FREIGHT_STATUS, PAYMENT_METHODS, PAYMENT_METHOD_LABEL } from "@/lib/domain";
import { unicosPorId, type OpcaoSelecionavel } from "@/lib/search-select-utils";
import SearchableSelect from "@/components/SearchableSelect";

type Action = (prev: string | null, fd: FormData) => Promise<string | null>;

export default function FreightForm({
  action,
  customers,
  vehicles,
  freight,
  valorInicial,
  submitLabel = "Salvar Frete",
}: {
  action: Action;
  customers: { id: number; name: string; doc?: string; phone: string }[];
  vehicles: { id: number; name: string }[];
  freight?: any;
  /** Preenche o valor quando vem da calculadora de frete. */
  valorInicial?: string;
  submitLabel?: string;
}) {
  const [error, formAction] = useActionState(action, null);
  const v = freight ?? {};
  const [origin, setOrigin] = useState(v.origin ?? "");
  const [destination, setDestination] = useState(v.destination ?? "");
  const [amount, setAmount] = useState(valorInicial ?? ((v.amount_cents ?? 0) / 100).toFixed(2));

  // busca dinamica de cliente: mesmas opcoes do select, deduplicadas por id
  const opcoesCliente: OpcaoSelecionavel[] = useMemo(
    () =>
      unicosPorId(customers, (c) => c.id).map((c) => ({
        value: String(c.id),
        label: c.name,
        digitos: [c.doc ?? "", c.phone ?? ""],
      })),
    [customers],
  );
  const [customerId, setCustomerId] = useState(String(v.customer_id ?? ""));
  return (
    <form action={formAction} className="space-y-4">
      {freight && <input type="hidden" name="id" value={freight.id} />}
      <Grid>
        <Field label="Cliente cadastrado">
          <select name="customer_id" value={customerId} onChange={(e) => setCustomerId(e.target.value)} className="campo">
            <option value="">Sem cliente cadastrado</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <div className="mt-2">
            <SearchableSelect
              options={opcoesCliente}
              onSelect={setCustomerId}
              label="Buscar cliente por nome, CPF ou telefone"
            />
          </div>
        </Field>
        <Field label="Nome do contato">
          <input name="contact_name" defaultValue={v.contact_name ?? ""} className="campo" />
        </Field>
        <Field label="Telefone">
          <input name="phone" defaultValue={v.phone ?? ""} inputMode="tel" className="campo" />
        </Field>
        <Field label="Data *">
          <input name="date" type="date" defaultValue={v.date ?? ""} className="campo" required />
        </Field>
        <Field label="Horário">
          <input name="time" type="time" defaultValue={v.time ?? ""} className="campo" />
        </Field>
        <Field label="Veículo">
          <select name="vehicle_id" defaultValue={v.vehicle_id ?? ""} className="campo">
            <option value="">Sem veículo</option>
            {vehicles.map((veic) => (
              <option key={veic.id} value={veic.id}>
                {veic.name}
              </option>
            ))}
          </select>
        </Field>
      </Grid>

      <Field label="Origem">
        <input name="origin" value={origin} onChange={e => setOrigin(e.target.value)} className="campo" />
      </Field>
      <Field label="Destino">
        <input name="destination" value={destination} onChange={e => setDestination(e.target.value)} className="campo" />
      </Field>
      <RouteEstimate tipo="comum" origin={origin} destination={destination} onApply={setAmount} />
      <Field label="Descrição da carga">
        <textarea name="cargo" defaultValue={v.cargo ?? ""} rows={2} className="campo" />
      </Field>

      <Grid cols={3}>
        <Field label="Valor (R$)">
          <input
            name="amount"
            value={amount}
            onChange={e => setAmount(e.target.value)}
            inputMode="decimal"
            className="campo"
          />
        </Field>
        <Field label="Forma de pagamento">
          <select name="method" defaultValue={v.method ?? "pix"} className="campo">
            {PAYMENT_METHODS.map((m) => (
              <option key={m} value={m}>
                {PAYMENT_METHOD_LABEL[m]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Status">
          <select name="status" defaultValue={v.status ?? "orcamento"} className="campo">
            {FREIGHT_STATUS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </Field>
      </Grid>

      <Field label="Observações">
        <textarea name="notes" defaultValue={v.notes ?? ""} rows={2} className="campo" />
      </Field>

      {error && (
        <p className="rounded-xl border border-red-300 bg-red-50 px-3 py-2 text-sm font-medium text-red-700">{error}</p>
      )}
      <SubmitButton className="w-full sm:w-auto">{submitLabel}</SubmitButton>
    </form>
  );
}
