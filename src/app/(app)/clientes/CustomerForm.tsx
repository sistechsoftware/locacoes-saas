"use client";
import { useActionState } from "react";
import { Field, Grid } from "@/components/ui";
import { SubmitButton } from "@/components/SubmitButton";

type Action = (prev: string | null, fd: FormData) => Promise<string | null>;

export default function CustomerForm({
  action,
  customer,
  next,
  submitLabel = "Salvar Cliente",
}: {
  action: Action;
  customer?: any;
  next?: string;
  submitLabel?: string;
}) {
  const [error, formAction] = useActionState(action, null);
  const v = customer ?? {};
  return (
    <form action={formAction} className="space-y-4">
      {customer && <input type="hidden" name="id" value={customer.id} />}
      {next && <input type="hidden" name="next" value={next} />}

      <Field label="Nome *">
        <input name="name" defaultValue={v.name ?? ""} className="campo" required autoFocus={!customer} />
      </Field>

      <Grid>
        <Field label="CPF / CNPJ">
          <input name="doc" defaultValue={v.doc ?? ""} className="campo" inputMode="numeric" />
        </Field>
        <Field label="Telefone">
          <input name="phone" defaultValue={v.phone ?? ""} className="campo" inputMode="tel" placeholder="11999998888" />
        </Field>
        <Field label="WhatsApp" hint="Se vazio, usa o telefone.">
          <input name="whatsapp" defaultValue={v.whatsapp ?? ""} className="campo" inputMode="tel" />
        </Field>
        <Field label="E-mail">
          <input name="email" type="email" defaultValue={v.email ?? ""} className="campo" />
        </Field>
        <Field label="Data de nascimento" hint="Opcional. Serve para avisar o aniversário do cliente.">
          <input
            name="birth_date"
            type="date"
            max="2100-12-31"
            defaultValue={(v.birth_date ?? "").slice(0, 10)}
            className="campo"
          />
        </Field>
      </Grid>

      <Field label="Endereço">
        <input name="address" defaultValue={v.address ?? ""} className="campo" />
      </Field>

      <Grid cols={3}>
        <Field label="Bairro">
          <input name="district" defaultValue={v.district ?? ""} className="campo" />
        </Field>
        <Field label="Cidade">
          <input name="city" defaultValue={v.city ?? ""} className="campo" />
        </Field>
        <Field label="CEP">
          <input name="zip" defaultValue={v.zip ?? ""} className="campo" inputMode="numeric" />
        </Field>
      </Grid>

      <Field label="Observações">
        <textarea name="notes" defaultValue={v.notes ?? ""} rows={3} className="campo" />
      </Field>

      {error && (
        <p className="rounded-xl border border-red-300 bg-red-50 px-3 py-2 text-sm font-medium text-red-700">{error}</p>
      )}
      <SubmitButton className="w-full sm:w-auto">{submitLabel}</SubmitButton>
    </form>
  );
}
