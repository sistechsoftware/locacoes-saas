"use client";
import { useActionState } from "react";
import { Field, Grid } from "@/components/ui";
import { SubmitButton } from "@/components/SubmitButton";
import PessoaDocumentoFields from "@/components/PessoaDocumento";
import { completarCadastroAction } from "./actions";

/**
 * Complemento cadastral de contas antigas (migração 0037 deixou os campos em
 * NULL — nada é suposto). Só aparece em Minha conta enquanto faltar dado, e o
 * backend preenche apenas o que está vazio: tipo de pessoa e documento não
 * mudam depois de gravados.
 */
export default function CompletarCadastroForm({
  semDocumento,
  semEmail,
}: {
  /** Conta ainda sem tipo de pessoa/documento: mostra o bloco PF/PJ. */
  semDocumento: boolean;
  /** Conta sem e-mail: mostra o campo (canal da recuperação de senha). */
  semEmail: boolean;
}) {
  const [error, action] = useActionState(completarCadastroAction, null);
  return (
    <div className="mt-4 rounded-xl border border-amber-300 bg-amber-50 p-3">
      <p className="mb-2 text-sm font-bold text-amber-900">Complete seu cadastro</p>
      <p className="mb-3 text-xs leading-relaxed text-amber-800">
        {semDocumento
          ? "Sua conta foi criada antes da exigência de CPF/CNPJ. Preencha abaixo para terminar de identificar a conta e habilitar o login por CPF/CNPJ — o acesso continua liberado enquanto isso."
          : "Seu cadastro ainda não tem e-mail. Informe abaixo — é por ele que chegam os avisos da conta e o link de recuperação de senha."}
      </p>
      <form action={action} className="space-y-3">
        {semDocumento && (
          <Grid>
            <PessoaDocumentoFields />
          </Grid>
        )}
        {semEmail && (
          <Grid cols={1}>
            <Field label="E-mail *" hint="Canal da recuperação de senha e dos avisos da conta.">
              <input
                name="email"
                type="email"
                className="campo"
                required
                maxLength={120}
                autoComplete="email"
                placeholder="voce@empresa.com.br"
              />
            </Field>
          </Grid>
        )}
        {error && <p className="text-sm font-medium text-red-700">{error}</p>}
        <SubmitButton variant="secundario">Salvar cadastro</SubmitButton>
      </form>
    </div>
  );
}
