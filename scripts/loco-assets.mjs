/**
 * Gerador dos assets visuais da marca **Locô**.
 *
 * Fonte unica da identidade: os arquivos em `brand/` (enviados pela marca).
 * Este script nunca redesenha a marca — apenas recorta, reduz e compoe o que
 * ja existe, para gerar os formatos que o navegador/PWA precisa:
 *
 *   public/icones/icone-192.png          -> <link rel="icon"> / notificacoes
 *   public/icones/icone-512.png          -> <link rel="icon"> / instalacao
 *   public/icones/icone-maskable-512.png -> manifest (purpose "maskable")
 *   public/icones/apple-touch-icon.png   -> iOS "Adicionar a tela de inicio"
 *   public/icones/loco-logo.png          -> logo horizontal (institucional)
 *   public/favicon.ico                   -> fallback que o navegador pede sozinho
 *
 * Rodar com: node scripts/loco-assets.mjs
 * Depois:    node scripts/splash.cjs   (regenera as splash a partir do icone 512)
 *
 * Coleta da marca (lidas das imagens oficiais):
 *   tinta   #14161B   laranja #FE7316   creme #F6F3EC
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const BRAND = path.join(ROOT, "brand");
const OUT = path.join(ROOT, "public", "icones");
const PUBLIC = path.join(ROOT, "public");

const TINTA = "#14161B"; // --color-tinta-900
const CREME = "#F6F3EC"; // logo claro sobre fundo escuro

const ICON_SRC = path.join(BRAND, "loco-app-icon-dark.png");
const LOGO_SRC = path.join(BRAND, "loco-logo.png");

fs.mkdirSync(OUT, { recursive: true });

/** Fundo opaco cheio (quadrado), com o simbolo composto por cima. */
async function quadradoOpaco(size, escala) {
  const lado = Math.round(size * escala);
  const simbolo = await sharp(ICON_SRC).resize(lado, lado, { fit: "fill" }).png().toBuffer();
  return sharp({
    create: { width: size, height: size, channels: 4, background: TINTA },
  })
    .composite([{ input: simbolo, gravity: "centre" }])
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/* ------------------------------- ícones -------------------------------- */

// Simbolo com o proprio contorno do app icon (cantos transparentes), como na
// arte original: e o formato "any" do manifest e o badge das notificacoes.
await sharp(ICON_SRC).resize(512, 512, { fit: "fill" }).png({ compressionLevel: 9 }).toFile(path.join(OUT, "icone-512.png"));
await sharp(ICON_SRC).resize(192, 192, { fit: "fill" }).png({ compressionLevel: 9 }).toFile(path.join(OUT, "icone-192.png"));

// Maskable: o Android recorta um circulo central de ~80%. O conteudo do
// simbolo ocupa 66% do quadro e esta centrado, entao 90% mantem tudo dentro
// da zona segura sobre um fundo cheio (sem canto transparente).
fs.writeFileSync(path.join(OUT, "icone-maskable-512.png"), await quadradoOpaco(512, 0.9));

// iOS ignora o manifest e aplica a mascara dele: a imagem precisa ser opaca.
fs.writeFileSync(path.join(OUT, "apple-touch-icon.png"), await quadradoOpaco(180, 1));

/* -------------------------------- logo --------------------------------- */

// Logo institucional recortado da margem transparente (versao escura).
await sharp(LOGO_SRC)
  .trim({ threshold: 10 })
  .png({ compressionLevel: 9 })
  .toFile(path.join(OUT, "loco-logo.png"));

/* ------------------------------- favicon ------------------------------- */

/**
 * ICO com as tres densidades habituais. O formato aceita PNG embutido desde o
 * Vista, entao nao ha que reencodar em BMP: cada entrada e so um PNG.
 */
function ico(pngs) {
  const entradas = pngs.map(({ size, buf }) => ({
    w: size >= 256 ? 0 : size,
    h: size >= 256 ? 0 : size,
    buf,
  }));
  const cabecalho = Buffer.alloc(6);
  cabecalho.writeUInt16LE(0, 0); // reservado
  cabecalho.writeUInt16LE(1, 2); // tipo: icone
  cabecalho.writeUInt16LE(entradas.length, 4);
  const diretorio = [];
  let offset = 6 + entradas.length * 16;
  for (const e of entradas) {
    const item = Buffer.alloc(16);
    item.writeUInt8(e.w, 0);
    item.writeUInt8(e.h, 1);
    item.writeUInt8(0, 2); // paleta
    item.writeUInt8(0, 3); // reservado
    item.writeUInt16LE(1, 4); // planes
    item.writeUInt16LE(32, 6); // bits
    item.writeUInt32LE(e.buf.length, 8);
    item.writeUInt32LE(offset, 12);
    diretorio.push(item);
    offset += e.buf.length;
  }
  return Buffer.concat([cabecalho, ...diretorio, ...entradas.map((e) => e.buf)]);
}

const faviconPngs = [];
for (const size of [16, 32, 48]) {
  faviconPngs.push({ size, buf: await quadradoOpaco(size, 1) });
}
fs.writeFileSync(path.join(PUBLIC, "favicon.ico"), ico(faviconPngs));

const gerados = [
  "public/icones/icone-192.png",
  "public/icones/icone-512.png",
  "public/icones/icone-maskable-512.png",
  "public/icones/apple-touch-icon.png",
  "public/icones/loco-logo.png",
  "public/favicon.ico",
];
console.log("Assets da marca Locô gerados:");
for (const g of gerados) {
  console.log(`  - ${g} (${(fs.statSync(path.join(ROOT, g)).size / 1024).toFixed(1)} kB)`);
}
