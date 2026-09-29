"use client";
import { useState, useTransition } from "react";
import { acaoPlataformaAction } from "./actions";

const OPCOES = [
  ["reativar_trial", "Reiniciar trial (14 dias)"],
  ["reativar", "Reativar acesso"],
  ["suspender", "Suspender acesso"],
  ["cancelar", "Cancelar assinatura"],
] as const;

export default function AcoesEmpresa({ companyId }: { companyId: number }) {
  const [aberto, setAberto] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function executar(acao: (typeof OPCOES)[number][0]) {
    setAberto(false);
    start(async () => {
      const r = await acaoPlataformaAction(companyId, acao);
      setMsg(r.mensagem);
    });
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setAberto((v) => !v)}
        disabled={pending}
        className="rounded-lg border border-stone-300 px-2.5 py-1 text-xs font-semibold text-stone-700 hover:bg-stone-50 disabled:opacity-60"
      >
        {pending ? "…" : "Ações"}
      </button>
      {aberto && (
        <div className="absolute right-0 z-10 mt-1 w-52 overflow-hidden rounded-xl border border-stone-200 bg-white shadow-lg">
          {OPCOES.map(([valor, rotulo]) => (
            <button
              key={valor}
              type="button"
              onClick={() => executar(valor)}
              className="block w-full px-3 py-2 text-left text-xs font-medium text-tinta-900 hover:bg-marca-50"
            >
              {rotulo}
            </button>
          ))}
        </div>
      )}
      {msg && <span className="ml-2 text-xs text-stone-500">{msg}</span>}
    </div>
  );
}
