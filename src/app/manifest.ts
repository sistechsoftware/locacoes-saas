import type { MetadataRoute } from "next";

/**
 * Manifesto do PWA: e o que permite instalar o sistema na tela de inicio do
 * celular com a logo da empresa, abrindo em tela cheia em vez de dentro do
 * navegador.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Lima's Fretes e Locações",
    short_name: "Lima's",
    description: "Gestão de locações, fretes e eventos",
    start_url: "/dashboard",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#F5F7FF",
    theme_color: "#051094",
    lang: "pt-BR",
    icons: [
      { src: "/icones/icone-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icones/icone-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      // o Android recorta a borda do icone; esta versao ja tem margem para isso
      { src: "/icones/icone-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
