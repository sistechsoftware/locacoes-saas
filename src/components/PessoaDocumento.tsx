"use client";
import { useState } from "react";
import { Field } from "@/components/ui";
import { mascaraDocumento, type TipoPessoa } from "@/lib/identidade";

/**
 * Campo de Tipo de pessoa (PF/PJ) + o documento correspondente.
 *
 * Um ÚNICO campo de documento, cujo rótulo/máscara trocam com o tipo escolhido
 * — CPF e CNPJ nunca aparecem juntos. A validação real (dígito verificador,
 * obrigatoriedade, unicidade) acontece no servidor; aqui é só assistência:
 * máscara progressiva, rótulos claros e teclado numérico no celular.
 *
 * Sem default: o usuário precisa ESCOLHER PF ou PJ antes de enviar
 * (radio `required` — o navegador bloquea o envio sem seleção).
 */
export default function PessoaDocumentoFields({
  tipoName = "tipo_pessoa",
  documentoName = "documento",
  obrigatorio = true,
}: {
  tipoName?: string;
  documentoName?: string;
  obrigatorio?: boolean;
}) {
  const [tipo, setTipo] = useState<TipoPessoa | null>(null);

  const opcoes: { valor: TipoPessoa; rotulo: string }[] = [
    { valor: "pf", rotulo: "Pessoa Física (PF)" },
    { valor: "pj", rotulo: "Pessoa Jurídica (PJ)" },
  ];

  return (
    <>
      <Field label="Tipo de pessoa *" hint="Escolha antes de preencher o documento.">
        <div role="radiogroup" aria-label="Tipo de pessoa" className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {opcoes.map((o) => (
            <label
              key={o.valor}
              className={`flex cursor-pointer items-center gap-2 rounded-xl border px-3 py-2.5 text-sm font-medium transition ${
                tipo === o.valor
                  ? "border-marca-600 bg-marca-50 text-marca-700"
                  : "border-nuvem-300 bg-white text-tinta-900 hover:bg-nuvem-50"
              }`}
            >
              <input
                type="radio"
                name={tipoName}
                value={o.valor}
                required={obrigatorio}
                checked={tipo === o.valor}
                onChange={() => setTipo(o.valor)}
                className="accent-marca-600"
              />
              {o.rotulo}
            </label>
          ))}
        </div>
      </Field>

      {tipo && (
        <Field
          key={tipo}
          label={tipo === "pf" ? "CPF *" : "CNPJ *"}
          hint={
            tipo === "pf"
              ? "Somente o dono da conta PF entra com o próprio CPF."
              : "CNPJ da empresa — usado também para as cobranças."
          }
        >
          <input
            name={documentoName}
            className="campo"
            inputMode="numeric"
            autoComplete="off"
            aria-label={tipo === "pf" ? "CPF" : "CNPJ"}
            required={obrigatorio}
            maxLength={tipo === "pf" ? 14 : 18}
            placeholder={tipo === "pf" ? "000.000.000-00" : "00.000.000/0000-00"}
            onChange={(e) => {
              e.currentTarget.value = mascaraDocumento(tipo, e.currentTarget.value);
            }}
          />
        </Field>
      )}
    </>
  );
}
