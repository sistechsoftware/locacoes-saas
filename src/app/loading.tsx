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
        {/* Simbolo do Locô (icones/icone-512) sobre a tinta da marca: os cantos
            transparentes do app icon se fundem ao fundo e o pulso nao muda a
            geometria — nenhum salto de layout durante a espera. */}
        <span
          className="h-12 w-12 rounded-2xl bg-tinta-900"
          style={{
            backgroundImage: "url(/icones/icone-512.png)",
            backgroundSize: "cover",
            backgroundPosition: "center",
            animation: "loco-pulso 1.1s ease-in-out infinite",
          }}
        />
        <span className="text-sm text-stone-400">Carregando…</span>
      </div>
      <style>{`@keyframes loco-pulso { 0%,100% { transform: scale(1); opacity: 1 } 50% { transform: scale(0.9); opacity: 0.75 } }`}</style>
    </div>
  );
}
