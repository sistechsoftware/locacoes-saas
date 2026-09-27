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
