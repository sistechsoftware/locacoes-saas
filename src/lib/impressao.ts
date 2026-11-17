/*
 * Impressão no iPhone — regras compartilhadas entre o botão dos documentos
 * (src/app/(app)/contratos/[id]/PrintButton.tsx) e o diagnóstico em
 * /diagnostico-pwa.
 *
 * Por que existe: desde o iOS 27 o `window.print()` não abre a folha de
 * impressão quando o app roda INSTALADO (display-mode: standalone) — a chamada
 * executa, nenhum erro aparece e `beforeprint` nunca dispara. No Safari a
 * mesma página imprime normalmente. O contorno é reabrir o documento no Safari
 * pelo esquema `x-safari-<url>`, que a Apple NÃO documenta: pode ser ignorado
 * sem aviso nenhum. Por isso o mesmo código é exposto em /diagnostico-pwa (para
 * o usuário testar no aparelho real) e quem chama sempre precisa de um caminho
 * manual de reserva.
 *
 * Somente navegador: todo acesso é a window/document, nunca a banco ou sessão.
 */

/** Parâmetro que leva o pedido de impressão da PWA para o Safari. */
export const PARAM_IMPRESSAO = "imprimir";

/** App aberto pelo ícone da tela de início (e não numa aba do navegador). */
export function estaInstalado(): boolean {
  const nav = window.navigator as Navigator & { standalone?: boolean };
  return window.matchMedia("(display-mode: standalone)").matches || nav.standalone === true;
}

/** iPhone/iPad. iPadOS 13+ se apresenta como Mac, então o toque desempata. */
export function ehIOS(): boolean {
  const ua = window.navigator.userAgent;
  return /iPad|iPhone|iPod/.test(ua) || (ua.includes("Macintosh") && "ontouchend" in document);
}

/** Endereço do documento sem a flag de impressão automática. */
export function urlDoDocumento(): URL {
  const url = new URL(window.location.href);
  url.searchParams.delete(PARAM_IMPRESSAO);
  return url;
}

/** O mesmo endereço com a flag que faz o Safari abrir a impressão sozinho. */
export function urlComImpressao(): URL {
  const url = urlDoDocumento();
  url.searchParams.set(PARAM_IMPRESSAO, "1");
  return url;
}

/**
 * Esquema do Safari. Não é documentado pela Apple: em algumas versões abre o
 * Safari, em outras é ignorado silenciosamente — quem chama precisa de um
 * caminho manual de reserva.
 */
export function linkSafari(url: URL | string = urlComImpressao()): string {
  return `x-safari-${String(url)}`;
}

/**
 * Avisa quando a página realmente saiu de primeiro plano (o Safari abriu).
 * `blur` fica de fora de propósito: o alerta do próprio sistema também borra a
 * janela e daria falso positivo, escondendo o caminho manual do usuário.
 */
export function aoSairDoApp(cb: () => void): () => void {
  let feito = false;
  const marcar = () => {
    if (feito) return;
    feito = true;
    cb();
  };
  const verVisibilidade = () => {
    if (document.visibilityState === "hidden") marcar();
  };
  window.addEventListener("pagehide", marcar);
  document.addEventListener("visibilitychange", verVisibilidade);
  return () => {
    window.removeEventListener("pagehide", marcar);
    document.removeEventListener("visibilitychange", verVisibilidade);
  };
}
