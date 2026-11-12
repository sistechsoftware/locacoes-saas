"use client";
import { useActionState } from "react";
import { loginAction } from "./actions";
import { SubmitButton } from "@/components/SubmitButton";
import { Field } from "@/components/ui";

/**
 * Formulario de login. `proximo` e o caminho interno para onde voltar depois
 * de entrar (impressao aberta no Safari do iPhone, por exemplo) — ja chega
 * validado pelo servidor (destinoInterno) e viaja num campo oculto.
 */
export default function LoginForm({ proximo = "" }: { proximo?: string }) {
  const [error, action] = useActionState(loginAction, null);
  return (
    <form action={action} className="space-y-4">
      {proximo && <input type="hidden" name="proximo" value={proximo} />}
      <Field label="CPF, CNPJ ou e-mail">
        <input
          name="identifier"
          className="campo"
          autoCapitalize="none"
          autoCorrect="off"
          autoComplete="username"
          required
          maxLength={160}
          placeholder="Informe seu CPF, CNPJ ou e-mail"
        />
      </Field>
      <Field label="Senha">
        <input
          name="password"
          type="password"
          className="campo"
          autoComplete="current-password"
          required
          placeholder="••••••••"
        />
      </Field>
      {error && (
        <p className="rounded-xl border border-red-300 bg-red-50 px-3 py-2 text-sm font-medium text-red-700">{error}</p>
      )}
      <SubmitButton className="w-full py-3 text-base">Entrar</SubmitButton>
    </form>
  );
}
