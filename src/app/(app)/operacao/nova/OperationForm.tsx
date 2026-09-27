"use client";
import { useActionState, useMemo, useState } from "react";
import { Field, Grid } from "@/components/ui";
import { SubmitButton } from "@/components/SubmitButton";
import { OPERATION_KINDS, OPERATION_STATUS } from "@/lib/domain";
import { unicosPorId, type OpcaoSelecionavel } from "@/lib/search-select-utils";
import SearchableSelect from "@/components/SearchableSelect";

type Action = (prev: string | null, fd: FormData) => Promise<string | null>;

export default function OperationForm({
  action,
  reservations,
  vehicles,
  users,
  defaultReservation,
  defaultKind,
}: {
  action: Action;
  reservations: { id: number; number: string; customer_name: string; event_date: string }[];
  vehicles: { id: number; name: string }[];
  users: { id: number; name: string }[];
  defaultReservation?: number;
  defaultKind?: string;
}) {
  const [error, formAction] = useActionState(action, null);
  const [reservationId, setReservationId] = useState(defaultReservation ? String(defaultReservation) : "");

  // busca dinamica de reserva: mesmas opcoes do select, deduplicadas por id
  // do registro; o cliente e a data aparecem na opcao para identificar
  const opcoesReserva: OpcaoSelecionavel[] = useMemo(
    () =>
      unicosPorId(reservations, (r) => r.id).map((r) => ({
        value: String(r.id),
        label: `${r.number} - ${r.customer_name} (${r.event_date})`,
        digitos: [r.number.replace(/\D/g, "")],
      })),
    [reservations],
  );

  return (
    <form action={formAction} className="space-y-4">
      <Field label="Tipo de Operação">
        <select name="kind" defaultValue={defaultKind ?? "entrega"} className="campo">
          {OPERATION_KINDS.map((k) => (
            <option key={k.value} value={k.value}>
              {k.icon} {k.label}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Reserva *">
        <select
          name="reservation_id"
          value={reservationId}
          onChange={(e) => setReservationId(e.target.value)}
          className="campo"
          required
        >
          <option value="">Selecione…</option>
          {reservations.map((r) => (
            <option key={r.id} value={r.id}>
              {r.number} - {r.customer_name} ({r.event_date})
            </option>
          ))}
        </select>
        <div className="mt-2">
          <SearchableSelect
            options={opcoesReserva}
            onSelect={setReservationId}
            label="Buscar reserva por número (ou nome do cliente)"
          />
        </div>
      </Field>

      <Grid>
        <Field label="Data e Horário *">
          <input name="scheduled_at" type="datetime-local" className="campo" required />
        </Field>
        <Field label="Status">
          <select name="status" defaultValue="pendente" className="campo">
            {OPERATION_STATUS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Responsável">
          <input name="assignee" className="campo" placeholder="Quem vai executar" />
        </Field>
        <Field label="Usuário responsável pelos avisos" hint="Opcional. Quando definido, recebe com exclusividade.">
          <select name="assignee_id" className="campo"><option value="">Equipe pelas funções</option>{users.map(u=><option key={u.id} value={u.id}>{u.name}</option>)}</select>
        </Field>
        <Field label="Veículo">
          <select name="vehicle_id" className="campo">
            <option value="">Sem veículo</option>
            {vehicles.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        </Field>
      </Grid>

      <Field label="Observações">
        <textarea name="notes" rows={3} className="campo" />
      </Field>

      {error && (
        <p className="rounded-xl border border-red-300 bg-red-50 px-3 py-2 text-sm font-medium text-red-700">{error}</p>
      )}
      <SubmitButton className="w-full sm:w-auto">Agendar Operação</SubmitButton>
    </form>
  );
}
