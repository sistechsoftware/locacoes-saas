"use client";
import { useActionState } from "react";
import { SubmitButton } from "@/components/SubmitButton";
import { Field } from "@/components/ui";
import { pedirRedefinicaoAction } from "./actions";

export default function RecuperarForm() {
  const [ok, action] = useActionState(pedirRedefinicaoAction, false);
  return (
    <>
      {ok ? (
        <p className="rounded-xl border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          Se o seu usuário tiver e-mail cadastrado, o link de redefinição foi enviado. Verifique a caixa de entrada
          e a caixa de spam — o link vale por 1 hora.
        </p>
      ) : (
        <form action={action} className="space-y-4">
          <Field label="Usuário">
            <input
              name="username"
              className="campo"
              autoCapitalize="none"
              autoCorrect="off"
              autoComplete="username"
              required
              placeholder="ex.: joao"
            />
          </Field>
          <SubmitButton className="w-full py-3 text-base">Enviar link de redefinição</SubmitButton>
        </form>
      )}
    </>
  );
}
