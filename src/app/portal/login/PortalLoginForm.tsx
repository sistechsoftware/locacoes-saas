"use client";
import { useActionState } from "react";
import { portalLoginAction } from "../actions";
import { SubmitButton } from "@/components/SubmitButton";
import { Field } from "@/components/ui";

/** Mascara leve de CPF enquanto digita: 000.000.000-00. */
function mascaraCpf(v: string): string {
  const d = v.replace(/\D/g, "").slice(0, 11);
  if (d.length <= 3) return d;
  if (d.length <= 6) return `${d.slice(0, 3)}.${d.slice(3)}`;
  if (d.length <= 9) return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6)}`;
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
}

export default function PortalLoginForm() {
  const [error, action] = useActionState(portalLoginAction, null);
  return (
    <form action={action} className="space-y-4">
      <Field label="Seu CPF">
        <input
          name="cpf"
          inputMode="numeric"
          autoComplete="username"
          required
          placeholder="000.000.000-00"
          className="campo"
          onChange={(e) => {
            e.currentTarget.value = mascaraCpf(e.currentTarget.value);
          }}
        />
      </Field>
      <Field label="Senha">
        <input
          name="password"
          type="password"
          autoComplete="current-password"
          required
          placeholder="••••••••"
          className="campo"
        />
      </Field>
      {error && (
        <p className="rounded-xl border border-red-300 bg-red-50 px-3 py-2 text-sm font-medium text-red-700">{error}</p>
      )}
      <SubmitButton className="w-full py-3 text-base">Entrar no portal</SubmitButton>
    </form>
  );
}
