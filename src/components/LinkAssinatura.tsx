"use client";
import { useState } from "react";

/**
 * Link de assinatura recem-criado.
 *
 * O token so existe legivel neste instante: no banco fica so o hash. Por isso
 * a tela avisa que ele nao volta a aparecer, e o botao copia de uma vez, que e
 * o que o operador faz em seguida para colar no WhatsApp.
 */
export default function LinkAssinatura({ url, whatsapp }: { url: string; whatsapp: string | null }) {
  const [copiado, setCopiado] = useState(false);

  async function copiar() {
    try {
      await navigator.clipboard.writeText(url);
      setCopiado(true);
      setTimeout(() => setCopiado(false), 2500);
    } catch {
      // navegador sem permissao de area de transferencia: o campo abaixo
      // continua selecionavel a mao
      setCopiado(false);
    }
  }

  return (
    <div className="rounded-xl border border-emerald-300 bg-emerald-50 p-3">
      <p className="text-sm font-bold text-emerald-900">Link gerado. Copie agora.</p>
      <p className="mt-0.5 text-xs text-emerald-800">
        Por segurança, o endereço completo não volta a aparecer nesta tela. Se perder, gere outro.
      </p>
      <input
        readOnly
        value={url}
        onFocus={(e) => e.currentTarget.select()}
        className="mt-2 w-full rounded-lg border border-emerald-300 bg-white px-2 py-2 text-xs"
      />
      <div className="mt-2 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={copiar}
          className="rounded-xl bg-marca-600 px-3 py-2 text-sm font-semibold text-white"
        >
          {copiado ? "Copiado!" : "Copiar Link"}
        </button>
        {whatsapp && (
          <a
            href={`https://wa.me/${whatsapp}?text=${encodeURIComponent(
              `Segue o contrato para assinatura: ${url}`,
            )}`}
            target="_blank"
            rel="noreferrer"
            className="rounded-xl border border-emerald-400 bg-white px-3 py-2 text-sm font-semibold text-emerald-800"
          >
            Enviar no WhatsApp
          </a>
        )}
      </div>
    </div>
  );
}
