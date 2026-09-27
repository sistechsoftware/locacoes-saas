"use client";

import { useEffect } from "react";

/**
 * Boundary de erro do grupo autenticado (app interno).
 *
 * O Next renderiza este componente no lugar da pagina que quebrou, mantendo a
 * navegacao (Sidebar/TopBar) viva — o usuario continua podendo sair da tela
 * com problema. Cada erro e reportado para /api/log-erro e aparece em /erros.
 */
export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    try {
      fetch("/api/log-erro", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: `${error.name}: ${error.message}`.slice(0, 2000),
          digest: error.digest ?? null,
          route: null,
          url: window.location.pathname,
        }),
        keepalive: true,
      }).catch(() => {});
    } catch {}
  }, [error]);

  return (
    <div className="cartao p-6 text-center space-y-3">
      <h1 className="text-lg font-semibold">Esta tela falhou</h1>
      <p className="text-sm text-slate-500">
        O problema foi registrado. Você pode tentar de novo ou voltar para o Dashboard.
        {error.digest ? ` Código: ${error.digest}` : ""}
      </p>
      <div className="flex justify-center gap-2 pt-1">
        <button onClick={reset} className="rounded-xl bg-blue-600 px-4 py-2 text-sm text-white">
          Tentar de novo
        </button>
        <a href="/dashboard" className="rounded-xl border border-nuvem-300 px-4 py-2 text-sm">
          Ir para o Dashboard
        </a>
      </div>
    </div>
  );
}
