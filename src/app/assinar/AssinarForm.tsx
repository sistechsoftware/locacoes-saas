"use client";
import { useActionState } from "react";
import Link from "next/link";
import { criarEmpresaAction } from "./actions";
import { SubmitButton } from "@/components/SubmitButton";
import { Field } from "@/components/ui";
import PessoaDocumentoFields from "@/components/PessoaDocumento";

export default function AssinarForm({ planoInicial }: { planoInicial: string }) {
  const [error, action] = useActionState(criarEmpresaAction, null);
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="plano" value={planoInicial} />

      <Field label="Nome da empresa">
        <input name="empresa" className="campo" required maxLength={120} placeholder="Minha Empresa Locações" />
      </Field>
      <Field label="Seu nome">
        <input name="nome" className="campo" required maxLength={80} placeholder="Nome e sobrenome" />
      </Field>
      <PessoaDocumentoFields key={String(error)} />
      <Field label="E-mail *" hint="Para avisos da conta: fim do teste, cobranças e recuperação de senha.">
        <input
          name="email"
          type="email"
          className="campo"
          autoComplete="email"
          required
          maxLength={120}
          placeholder="voce@empresa.com.br"
        />
      </Field>
      <Field label="Usuário" hint="Você usará ele para entrar no sistema.">
        <input
          name="username"
          className="campo"
          autoCapitalize="none"
          autoCorrect="off"
          autoComplete="username"
          required
          minLength={3}
          maxLength={40}
          placeholder="ex.: joao"
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

      <label className="flex items-start gap-2 text-sm text-stone-600">
        <input type="checkbox" name="aceite" required className="mt-1" />
        <span>
          Li e aceito criar minha conta com <b>14 dias grátis</b>. Ao fim do período, a assinatura pode ser
          contratada a qualquer momento — nada é cobrado automaticamente.{" "}
          <Link href="/planos" className="font-semibold text-marca-600 underline">
            Ver planos
          </Link>
        </span>
      </label>

      {error && (
        <p className="rounded-xl border border-red-300 bg-red-50 px-3 py-2 text-sm font-medium text-red-700">{error}</p>
      )}
      <SubmitButton className="w-full py-3 text-base">Criar minha conta grátis</SubmitButton>
    </form>
  );
}
