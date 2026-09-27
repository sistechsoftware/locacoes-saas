/**
 * Shell de carregamento global (raiz).
 *
 * Cobertura final: qualquer rota fora do grupo (app) — /login, /portal,
 * /assinar — tambem responde ao toque com um shell imediato em vez de ficar
 * em branco ate o servidor responder. Mesmo visual do loading do grupo (app),
 * com altura cheia porque aqui nao existe barra superior/inferior.
 */
export default function RootLoading() {
  return (
    <div className="flex min-h-[100svh] items-center justify-center">
      <div className="flex flex-col items-center gap-3" aria-busy="true" aria-live="polite">
        <span
          className="flex h-12 w-12 items-center justify-center rounded-2xl bg-marca-600 text-xl font-black text-white"
          style={{ animation: "limas-pulso 1.1s ease-in-out infinite" }}
        >
          L
        </span>
        <span className="text-sm text-stone-400">Carregando…</span>
      </div>
      <style>{`@keyframes limas-pulso { 0%,100% { transform: scale(1); opacity: 1 } 50% { transform: scale(0.9); opacity: 0.75 } }`}</style>
    </div>
  );
}
