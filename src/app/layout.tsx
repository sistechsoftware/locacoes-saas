import type { Metadata, Viewport } from "next";
import "./globals.css";

/*
 * Splash screens nativas do iPhone.
 *
 * O iOS NAO le o manifest para splash (o Android gera a dele sozinho a partir
 * dos icones; no iPhone, sem isso, abrir a PWA instalada mostra TELA BRANCA
 * ate o primeiro HTML chegar). A solucao oficial da Apple e uma imagem por
 * modelo, escolhida por media query, via <link rel="apple-touch-startup-image">.
 *
 * As imagens estao em public/splash (geradas por scripts/splash.cjs a partir
 * do icone 512, sobre o fundo do app #F5F7FF) e sao servidas com cache HTTP,
 * entao o custo e zero a partir da primeira abertura. O iPhone baixa apenas a
 * imagem do modelo em uso — as outras 21 sao so links no HTML.
 *
 * As tags entram direto na arvore (React 19 eleva <link> ao <head>): o campo
 * metadata.icons do Next sempre emite rel="apple-touch-icon", e o Safari
 * precisa do rel exato "apple-touch-startup-image" para usar a splash.
 */
const IPHONES = [
  { w: 320, h: 568, dpr: 2 }, // SE 1/2/3, 5/6/7/8
  { w: 375, h: 667, dpr: 2 }, // 6/7/8, SE 2/3
  { w: 375, h: 812, dpr: 3 }, // X/XS/11 Pro/12 mini/13 mini
  { w: 390, h: 844, dpr: 3 }, // 12/13/14
  { w: 393, h: 852, dpr: 3 }, // 14 Pro/15/16
  { w: 414, h: 736, dpr: 3 }, // 7/8 Plus
  { w: 414, h: 896, dpr: 2 }, // 11/XR
  { w: 414, h: 896, dpr: 3 }, // 11 Pro Max/XS Max
  { w: 428, h: 926, dpr: 3 }, // 12/13 Pro Max, 14 Plus
  { w: 430, h: 932, dpr: 3 }, // 14/15/16 Pro Max, 15 Plus
  { w: 440, h: 956, dpr: 3 }, // 16 Pro Max
] as const;

const SPLASH_LINKS = IPHONES.flatMap(({ w, h, dpr }) => {
  const pw = w * dpr;
  const ph = h * dpr;
  return [
    <link
      key={`splash-${pw}x${ph}-p`}
      rel="apple-touch-startup-image"
      href={`/splash/apple-splash-${pw}-${ph}.png`}
      media={`(orientation: portrait) and (device-width: ${w}px) and (device-height: ${h}px) and (-webkit-device-pixel-ratio: ${dpr})`}
    />,
    <link
      key={`splash-${pw}x${ph}-l`}
      rel="apple-touch-startup-image"
      href={`/splash/apple-splash-${ph}-${pw}.png`}
      media={`(orientation: landscape) and (device-width: ${h}px) and (device-height: ${w}px) and (-webkit-device-pixel-ratio: ${dpr})`}
    />,
  ];
});

export const metadata: Metadata = {
  title: "Lima's Locações",
  description: "Gestão de Locações e Eventos",
  applicationName: "Lima's Locações",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/icones/icone-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icones/icone-512.png", sizes: "512x512", type: "image/png" },
    ],
    // o iOS ignora o manifesto e usa esta tag ao adicionar a tela de inicio
    apple: [{ url: "/icones/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  appleWebApp: {
    capable: true,
    title: "Lima's",
    statusBarStyle: "default",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  // Desenha ate as bordas do aparelho. Sem isso o Safari/PWA reporta
  // env(safe-area-inset-bottom) = 0 e a barra inferior encosta na Home Bar do
  // iPhone — toques na borda caem na area reservada aos gestos do iOS.
  viewportFit: "cover",
  themeColor: "#051094",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <body className="min-h-screen antialiased">
        {/*
         * Meta legada de modo standalone: o Next 15 emite so a variante sem
         * prefixo (mobile-web-app-capable), que o iOS moderno aceita — mas
         * versoes mais antigas (ex.: iOS 16) so respeitam a com prefixo
         * apple-. Sem modo standalone o iPhone nao usa splash nenhuma, entao
         * a variante legada fica explicita aqui (React 19 eleva ao <head>).
         * Ter as duas nao conflita: e o proprio padrao de transicao da Apple.
         */}
        <meta name="apple-mobile-web-app-capable" content="yes" />
        {SPLASH_LINKS}
        {children}
      </body>
    </html>
  );
}
