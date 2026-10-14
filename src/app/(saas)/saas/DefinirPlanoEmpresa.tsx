"use client";
import { useState, useTransition } from "react";
import { NOME_DO_PLANO, ORDEM_PLANOS } from "@/lib/planos";
import { definirPlanoAction } from "./actions";

/**
 * Define o plano de uma empresa pelo painel /saas (só platform_admin — o
 * guard é na action, aqui é só apresentação). Serve de reconciliação para
 * empresas cujo plano tenha sido gravado por fallback (checkout antigo) e
 * para correções comerciais pontuais; toda troca fica em audit_logs.
 */
export default function DefinirPlanoEmpresa({
  companyId,
  planoAtual,
}: {
  companyId: number;
  /** Nome comercial do plano vigente (exibição). */
  planoAtual?: string | null;
}) {
  const [aberto, setAberto] = useState(false);
  const [slug, setSlug] = useState<string>("");
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function salvar() {
    if (!slug) return;
    setMsg(null);
    start(async () => {
      const r = await definirPlanoAction(companyId, slug);
      setMsg(r.mensagem);
      if (r.ok) setAberto(false);
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={() => setAberto((v) => !v)}
        disabled={pending}
        className="rounded-lg border border-stone-300 px-2.5 py-1 text-xs font-semibold text-stone-700 hover:bg-stone-50 disabled:opacity-60"
      >
        {pending ? "…" : `Plano${planoAtual ? `: ${planoAtual}` : ""}`}
      </button>
      {aberto && (
        <span className="flex items-center gap-1.5 text-xs">
          <select
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            className="rounded-lg border border-stone-300 px-2 py-1 text-xs"
          >
            <option value="">Escolher plano…</option>
            {ORDEM_PLANOS.map((s) => (
              <option key={s} value={s}>
                {NOME_DO_PLANO[s]}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={salvar}
            disabled={!slug || pending}
            className="rounded-lg bg-marca-600 px-2.5 py-1 text-xs font-semibold text-white disabled:opacity-60"
          >
            Definir
          </button>
        </span>
      )}
      {msg && <span className="text-xs text-stone-500">{msg}</span>}
    </div>
  );
}
