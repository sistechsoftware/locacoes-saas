"use client";
import { useActionState } from "react";
import { Field, Grid } from "@/components/ui";
import { SubmitButton } from "@/components/SubmitButton";
import { changeOwnPassword } from "./actions";

export default function PasswordForm() {
  const [error, action] = useActionState(changeOwnPassword, null);
  return (
    <form action={action} className="space-y-3">
      <Grid>
        <Field label="Senha atual">
          <input name="current" type="password" className="campo" required />
        </Field>
        <Field label="Nova senha">
          <input name="next" type="password" className="campo" required minLength={6} />
        </Field>
      </Grid>
      {error && <p className="text-sm font-medium text-red-700">{error}</p>}
      <SubmitButton variant="secundario">Alterar minha senha</SubmitButton>
    </form>
  );
}
