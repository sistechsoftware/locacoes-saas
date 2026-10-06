import type { MetadataRoute } from "next";

/**
 * Manifesto do PWA: e o que permite instalar o Locô na tela de inicio do
 * celular com o icone oficial, abrindo em tela cheia em vez de dentro do
 * navegador.
 *
 * Identidade do PRODUTO: nome, cores e icones sao sempre os do Locô. A logo
 * do cliente nao entra aqui — manifest e favicon sao globais e nao podem ser
 * sobrescritos por nenhum tenant.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Locô — Gestão para locações",
    short_name: "Locô",
    description: "Gestão para locações: reservas, orçamentos, contratos, estoque e financeiro.",
    start_url: "/dashboard",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#F6F3EC",
    theme_color: "#14161B",
    lang: "pt-BR",
    icons: [
      { src: "/icones/icone-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icones/icone-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      // o Android recorta a borda do icone; esta versao ja tem margem para isso
      { src: "/icones/icone-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
