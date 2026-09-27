"use client";
import { useActionState } from "react";
import { loginAction } from "./actions";
import { SubmitButton } from "@/components/SubmitButton";
import { Field } from "@/components/ui";

export default function LoginForm() {
  const [error, action] = useActionState(loginAction, null);
  return (
    <form action={action} className="space-y-4">
      <Field label="Usuário">
        <input
          name="username"
          className="campo"
          autoCapitalize="none"
          autoCorrect="off"
          autoComplete="username"
          required
          placeholder="admin"
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
