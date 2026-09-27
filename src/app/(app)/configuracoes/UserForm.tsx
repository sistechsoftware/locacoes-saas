"use client";
import { useActionState } from "react";
import { Field, Grid } from "@/components/ui";
import { SubmitButton } from "@/components/SubmitButton";
import { createUser } from "./actions";

export default function UserForm() {
  const [error, action] = useActionState(createUser, null);
  return (
    <form action={action} className="space-y-3">
      <Grid>
        <Field label="Nome *">
          <input name="name" className="campo" required />
        </Field>
        <Field label="Usuário de login *" hint="Sem espaços, em minúsculo.">
          <input name="username" className="campo" required />
        </Field>
        <Field label="Senha *" hint="Mínimo 6 caracteres.">
          <input name="password" type="password" className="campo" required minLength={6} />
        </Field>
        <Field label="Perfil">
          <select name="role" defaultValue="operador" className="campo">
            <option value="operador">Operador</option>
            <option value="admin">Administrador</option>
          </select>
        </Field>
        <Field label="Telefone">
          <input name="phone" className="campo" />
        </Field>
        <Field label="E-mail">
          <input name="email" type="email" className="campo" />
        </Field>
      </Grid>
      {error && <p className="text-sm font-medium text-red-700">{error}</p>}
      <SubmitButton className="w-full sm:w-auto">Criar Usuário</SubmitButton>
    </form>
  );
}
