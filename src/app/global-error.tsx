"use client";

import { useEffect } from "react";

/**
 * Boundary de erro RAIZ (substitui ate o html/body).
 *
 * O Next renderiza este componente quando qualquer coisa acima de todo o app
 * quebra — inclusive falhas do layout raiz. Sem ele, o usuario via a tela
 * branca padrao do Next e ninguem ficava sabendo.
 *
 * O reporte e "fire and forget": se o envio falhar (ex.: sem rede), o botao
 * "Tentar de novo" segue funcionando do mesmo jeito.
 */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    try {
      fetch("/api/log-erro", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: `global-error: ${error.name}: ${error.message}`.slice(0, 2000),
          digest: error.digest ?? null,
          route: null,
          url: window.location.pathname,
        }),
        keepalive: true,
      }).catch(() => {});
    } catch {}
  }, [error]);

  return (
    <html lang="pt-BR">
      <body style={{ fontFamily: "system-ui, sans-serif", background: "#F5F7FF", color: "#1E293B" }}>
        <div
          style={{
            maxWidth: 480,
            margin: "18vh auto",
            textAlign: "center",
            padding: "2rem",
            background: "#fff",
            borderRadius: 16,
            boxShadow: "0 10px 40px rgba(30,41,59,.08)",
          }}
        >
          <h1 style={{ fontSize: "1.4rem", marginBottom: ".5rem" }}>Algo falhou no sistema</h1>
          <p style={{ color: "#64748B", marginBottom: "1.5rem" }}>
            O problema foi registrado e a equipe ja pode ver o que aconteceu.
            {error.digest ? ` Codigo: ${error.digest}` : ""}
          </p>
          <button
            onClick={reset}
            style={{
              background: "#2563EB",
              color: "#fff",
              border: 0,
              borderRadius: 10,
              padding: ".7rem 1.6rem",
              fontSize: "1rem",
              cursor: "pointer",
            }}
          >
            Tentar de novo
          </button>
        </div>
      </body>
    </html>
  );
}
