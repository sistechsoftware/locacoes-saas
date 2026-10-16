/**
 * Shell de carregamento do app.
 *
 * Cada clique em um menu (barra inferior, lateral, cartoes) troca de tela com
 * resposta VISUAL imediata: este esqueleto aparece na hora, enquanto o
 * servidor consulta o D1 (que fica longe — cada consulta custa uma volta
 * pela rede). Antes, o clique ficava sem reacao ate a pagina inteira chegar,
 * o que no iPhone/PWA parecia travamento.
 *
 * Fica no grupo (app), entao cobre todas as telas sem esconder o TopBar, a
 * barra inferior e o botao flutuante, que continuam visiveis (sao o layout
 * persistente). Com conteudo esq. branco ~ 100vh para o simbolo + margem nao
 * pular de altura entre uma tela e outra.
 */
export default function AppLoading() {
  return (
    <div className="flex min-h-[100svh] items-center justify-center">
      {/* Barra de progresso no topo: mesmo sinal da barra das actions
          (ProgressoAcoes), para a espera de NAVEGACAO ter um indicador
          continuo alem do pulso central — no desktop, o icone pequeno so
          no centro parecia "nada acontecendo". */}
      <div
        className="fixed inset-x-0 top-0 z-50 h-1 overflow-hidden bg-nuvem-200"
        role="status"
        aria-label="Carregando…"
        data-progresso-navegacao=""
      >
        <div
          className="h-full w-1/3 rounded-full bg-marca-600"
          style={{ animation: "loco-progresso 1.1s ease-in-out infinite" }}
        />
      </div>
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
      <style>{`@keyframes loco-pulso { 0%,100% { transform: scale(1); opacity: 1 } 50% { transform: scale(0.9); opacity: 0.75 } }\n@keyframes loco-progresso { 0% { transform: translateX(-100%) } 100% { transform: translateX(300%) } }`}</style>
    </div>
  );
}
