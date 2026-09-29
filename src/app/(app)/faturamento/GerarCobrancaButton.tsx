"use client";
import { useState, useTransition } from "react";
import { gerarCobrancaAction } from "./actions";

export default function GerarCobrancaButton() {
  const [msg, setMsg] = useState<{ ok: boolean; texto: string; url?: string } | null>(null);
  const [pending, start] = useTransition();

  return (
    <div className="mt-4">
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await gerarCobrancaAction();
            setMsg({ ok: r.ok, texto: r.mensagem, url: r.url });
          })
        }
        className="rounded-xl bg-marca-600 px-4 py-2.5 text-sm font-bold text-white shadow-sm transition hover:bg-marca-700 disabled:opacity-60"
      >
        {pending ? "Gerando…" : "Gerar cobrança PIX do próximo período"}
      </button>
      {msg && (
        <p className={`mt-2 text-sm ${msg.ok ? "text-green-700" : "text-red-700"}`}>
          {msg.texto}{" "}
          {msg.url && (
            <a href={msg.url} target="_blank" rel="noreferrer" className="underline">
              abrir fatura
            </a>
          )}
        </p>
      )}
    </div>
  );
}
