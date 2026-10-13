"use client";
import { useState, useTransition } from "react";
import { dadosPagamentoAction } from "./actions";

type Dados = {
  billingType: string;
  statusAsaas: string;
  invoiceUrl: string | null;
  bankSlipUrl: string | null;
  linhaDigitavel: string | null;
  pixPayload: string | null;
  pixQrCode: string | null;
};

/**
 * Botão por cobrança do histórico: consulta no servidor os dados de
 * pagamento da modalidade (fatura, boleto PDF + linha digitável, Pix QR e
 * copia-e-cola). A consulta é feita no servidor com o company_id da sessão —
 * cobrança de outra empresa responde "não encontrada".
 */
export default function DadosPagamentoButton({ pagamentoId, status }: { pagamentoId: number; status: string }) {
  const [dados, setDados] = useState<Dados | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [aberto, setAberto] = useState(false);
  const [pending, start] = useTransition();

  if (dados && aberto) {
    return (
      <div className="mt-2 w-full rounded-xl border border-stone-200 bg-stone-50 p-3 text-xs text-stone-700">
        <div className="mb-2 flex items-center justify-between gap-2">
          <span className="font-semibold">
            {dados.billingType === "PIX"
              ? "Pix"
              : dados.billingType === "BOLETO"
                ? "Boleto"
                : dados.billingType === "CREDIT_CARD"
                  ? "Cartão de crédito"
                  : dados.billingType === "UNDEFINED"
                    ? "Fatura (pagador escolhe)"
                    : dados.billingType}
          </span>
          <button type="button" className="text-marca-600 underline" onClick={() => setAberto(false)}>
            fechar
          </button>
        </div>
        {dados.invoiceUrl && (
          <p className="mb-1 break-all">
            <a href={dados.invoiceUrl} target="_blank" rel="noreferrer" className="text-marca-600 underline">
              abrir fatura
            </a>
          </p>
        )}
        {dados.bankSlipUrl && (
          <p className="mb-1 break-all">
            <a href={dados.bankSlipUrl} target="_blank" rel="noreferrer" className="text-marca-600 underline">
              boleto (PDF)
            </a>
          </p>
        )}
        {dados.linhaDigitavel && (
          <p className="mb-1 break-all font-mono">Linha digitável: {dados.linhaDigitavel}</p>
        )}
        {dados.pixPayload && <p className="mb-1 break-all font-mono">Pix copia e cola: {dados.pixPayload}</p>}
        {dados.pixQrCode && (
          <img src={`data:image/png;base64,${dados.pixQrCode}`} alt="QR Code Pix" className="mt-1 h-32 w-32" />
        )}
        {!dados.invoiceUrl && !dados.bankSlipUrl && !dados.linhaDigitavel && !dados.pixPayload && (
          <p>O Asaas não devolveu dados adicionais para esta cobrança.</p>
        )}
      </div>
    );
  }

  return (
    <>
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await dadosPagamentoAction(pagamentoId);
            if (r.ok) {
              setDados(r.dados);
              setErro(null);
              setAberto(true);
            } else {
              setErro(r.mensagem);
            }
          })
        }
        className="text-xs font-semibold text-marca-600 underline disabled:opacity-60"
      >
        {pending ? "Consultando…" : "dados de pagamento"}
      </button>
      {erro && <span className="ml-2 text-xs text-red-700">{erro}</span>}
    </>
  );
}
