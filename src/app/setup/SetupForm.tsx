"use client";
import { useActionState } from "react";
import { setupAction } from "./actions";
import { SubmitButton } from "@/components/SubmitButton";
import { Field } from "@/components/ui";

export default function SetupForm() {
  const [error, action] = useActionState(setupAction, null);
  return (
    <form action={action} className="space-y-4">
      <Field label="Nome da empresa">
        <input name="empresa" className="campo" required maxLength={120} placeholder="Minha Empresa Locações" />
      </Field>
      <Field label="Seu nome">
        <input name="nome" className="campo" required maxLength={80} placeholder="Nome e sobrenome" />
      </Field>
      <Field label="Usuário">
        <input
          name="username"
          className="campo"
          autoCapitalize="none"
          autoCorrect="off"
          autoComplete="username"
          required
          minLength={3}
          placeholder="ex.: ericlis"
        />
      </Field>
      <Field label="Senha (mínimo 8 caracteres)">
        <input
          name="senha"
          type="password"
          className="campo"
          autoComplete="new-password"
          required
          minLength={8}
          placeholder="••••••••"
        />
      </Field>
      {error && (
        <p className="rounded-xl border border-red-300 bg-red-50 px-3 py-2 text-sm font-medium text-red-700">{error}</p>
      )}
      <SubmitButton className="w-full py-3 text-base">Criar acesso e entrar</SubmitButton>
    </form>
  );
}
