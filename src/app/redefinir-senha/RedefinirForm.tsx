"use client";
import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { SubmitButton } from "@/components/SubmitButton";
import { Field } from "@/components/ui";
import { redefinirAction } from "./actions";

export default function RedefinirForm({ token }: { token: string }) {
  const [erro, action] = useActionState(redefinirAction, null);
  const router = useRouter();

  // Sucesso -> token consumido e sessões encerradas: vai para o login.
  useEffect(() => {
    if (erro === "OK") router.replace("/login?redefinida=1");
  }, [erro, router]);

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="token" value={token} />
      <Field label="Nova senha">
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
      <Field label="Confirmar nova senha">
        <input
          name="confirmacao"
          type="password"
          className="campo"
          autoComplete="new-password"
          required
          minLength={8}
          placeholder="••••••••"
        />
      </Field>
      {erro && erro !== "OK" && (
        <p className="rounded-xl border border-red-300 bg-red-50 px-3 py-2 text-sm font-medium text-red-700">{erro}</p>
      )}
      <SubmitButton className="w-full py-3 text-base">Salvar nova senha</SubmitButton>
    </form>
  );
}
