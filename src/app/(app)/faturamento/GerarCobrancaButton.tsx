"use client";
import { useState, useTransition } from "react";
import { gerarCobrancaAction } from "./actions";

/**
 * Seletor de meio de pagamento + geração da cobrança do próximo período.
 *
 *  * "Fatura — o pagador escolhe" = billingType UNDEFINED: a fatura do Asaas
 *    mostra ao pagador os meios habilitados na conta (Pix, cartão, boleto);
 *  * as demais opções fixam o meio na criação. Cartão é pago na fatura
 *    hospedada pelo Asaas — o Locô nunca vê dados do cartão.
 *
 * A disponibilidade real de cada meio depende da conta Asaas; por isso o
 * padrão é a fatura com escolha, que só exibe o que a conta efetivamente
 * processa. Erros do Asaas chegam como mensagem e nada é cobrado em silêncio.
 */
const MEIOS = [
  { valor: "UNDEFINED", rotulo: "Fatura — o pagador escolhe (Pix, cartão ou boleto)" },
  { valor: "PIX", rotulo: "Pix" },
  { valor: "BOLETO", rotulo: "Boleto bancário" },
  { valor: "CREDIT_CARD", rotulo: "Cartão de crédito" },
] as const;

const ROTULO_BILLING: Record<string, string> = {
  UNDEFINED: "fatura com escolha do pagador",
  PIX: "Pix",
  BOLETO: "boleto",
  CREDIT_CARD: "cartão de crédito",
};

type Resultado = {
  ok: boolean;
  mensagem: string;
  url?: string;
  bankSlipUrl?: string;
  linhaDigitavel?: string;
  billingType?: string;
};

export default function GerarCobrancaButton() {
  const [meio, setMeio] = useState<string>("UNDEFINED");
  const [msg, setMsg] = useState<Resultado | null>(null);
  const [pending, start] = useTransition();

  return (
    <div className="mt-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <label className="flex-1">
          <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-stone-500">
            Forma de pagamento
          </span>
          <select
            value={meio}
            onChange={(e) => setMeio(e.target.value)}
            disabled={pending}
            className="campo w-full"
          >
            {MEIOS.map((m) => (
              <option key={m.valor} value={m.valor}>
                {m.rotulo}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const r = await gerarCobrancaAction(meio);
              setMsg(r);
            })
          }
          className="rounded-xl bg-marca-600 px-4 py-2.5 text-sm font-bold text-white shadow-sm transition hover:bg-marca-700 disabled:opacity-60"
        >
          {pending ? "Gerando…" : "Gerar cobrança do próximo período"}
        </button>
      </div>
      {msg && (
        <div className={`mt-2 text-sm ${msg.ok ? "text-green-700" : "text-red-700"}`}>
          <p>
            {msg.mensagem}
            {msg.ok && msg.billingType ? (
              <span className="text-stone-500">
                {" "}
                (meio: {ROTULO_BILLING[msg.billingType] ?? msg.billingType})
              </span>
            ) : null}
          </p>
          {msg.ok && msg.url && (
            <p className="mt-1">
              <a href={msg.url} target="_blank" rel="noreferrer" className="underline">
                abrir fatura
              </a>
            </p>
          )}
          {msg.ok && msg.bankSlipUrl && (
            <p className="mt-1">
              <a href={msg.bankSlipUrl} target="_blank" rel="noreferrer" className="underline">
                baixar boleto (PDF)
              </a>
            </p>
          )}
          {msg.ok && msg.linhaDigitavel && (
            <p className="mt-1 break-all font-mono text-xs text-stone-600">
              Linha digitável: {msg.linhaDigitavel}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
