"use client";
import { useActionState } from "react";
import { portalSetupAction } from "../actions";
import { SubmitButton } from "@/components/SubmitButton";
import { Field } from "@/components/ui";

function mascaraCpf(v: string): string {
  const d = v.replace(/\D/g, "").slice(0, 11);
  if (d.length <= 3) return d;
  if (d.length <= 6) return `${d.slice(0, 3)}.${d.slice(3)}`;
  if (d.length <= 9) return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6)}`;
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
}

function mascaraFone(v: string): string {
  const d = v.replace(/\D/g, "").slice(0, 11);
  if (d.length <= 2) return d;
  if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
  if (d.length <= 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
}

/**
 * Formulario do convite. O token viaja em campo escondido; CPF, telefone e
 * senha sao conferidos no servidor (portal-auth.ts), nunca apenas aqui.
 */
export default function PortalSetupForm({ token }: { token: string }) {
  const [error, action] = useActionState(portalSetupAction, null);
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="token" value={token} />

      <Field label="Seu CPF" hint="Use o CPF cadastrado na Lima's.">
        <input
          name="cpf"
          inputMode="numeric"
          autoComplete="off"
          required
          placeholder="000.000.000-00"
          className="campo"
          onChange={(e) => {
            e.currentTarget.value = mascaraCpf(e.currentTarget.value);
          }}
        />
      </Field>

      <Field label="Telefone cadastrado" hint="O celular que a Lima's usa para falar com você.">
        <input
          name="telefone"
          inputMode="tel"
          autoComplete="off"
          required
          placeholder="(00) 00000-0000"
          className="campo"
          onChange={(e) => {
            e.currentTarget.value = mascaraFone(e.currentTarget.value);
          }}
        />
      </Field>

      <Field label="Crie sua senha" hint="Mínimo de 8 caracteres.">
        <input
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={8}
          required
          placeholder="••••••••"
          className="campo"
        />
      </Field>

      {error && (
        <p className="rounded-xl border border-red-300 bg-red-50 px-3 py-2 text-sm font-medium text-red-700">{error}</p>
      )}
      <SubmitButton className="w-full py-3 text-base">Criar meu acesso</SubmitButton>
    </form>
  );
}
