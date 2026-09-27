/**
 * Gerador das splash screens nativas do iOS (Apple NAO le o manifest para
 * splash: usa <link rel="apple-touch-startup-image"> com uma imagem por
 * modelo de iPhone, filtrada por media query).
 *
 * Fonte: public/icones/icone-512.png (a marca da empresa, sem altera-la).
 * Fundo: --color-nuvem-100 (#F5F7FF), o mesmo fundo do app, para a transicao
 * splash -> tela nao dar "pulo" de cor.
 *
 * Rodar com: node scripts/splash.cjs
 * (Regenerar so se a marca mudar ou um novo modelo de iPhone precisar de
 * suporte. As imagens sao staticas e versionadas em public/splash.)
 *
 * Sem dependencias novas: decodifica e codifica PNG com zlib embutido do
 * (truecolor RGBA na entrada, RGB na saida) — o mesmo formato que o projeto
 * ja usa nos icones.
 */
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const SRC = path.join(__dirname, "..", "public", "icones", "icone-512.png");
const OUT_DIR = path.join(__dirname, "..", "public", "splash");
const FUNDO = [0xf5, 0xf7, 0xff]; // --color-nuvem-100 (globals.css)

/* ------------------------------ PNG decode ------------------------------ */

function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })());
  c = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ table[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Decodifica PNG truecolor (colorType 2 ou 6, 8 bits, sem entrelace). */
function decodePng(file) {
  const b = fs.readFileSync(file);
  if (b.readUInt32BE(0) !== 0x89504e47) throw new Error("Nao e um PNG: " + file);
  let off = 8, w = 0, h = 0, colorType = 0, idat = [];
  while (off < b.length) {
    const len = b.readUInt32BE(off);
    const type = b.toString("ascii", off + 4, off + 8);
    const data = b.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      if (data[8] !== 8) throw new Error("BitDepth nao suportado");
      colorType = data[9];
      if (data[12] !== 0) throw new Error("PNG entrelaçado nao suportado");
    } else if (type === "IDAT") idat.push(data);
    off += 12 + len;
  }
  const bpp = colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const out = new Uint8Array(w * h * 4); // RGBA sempre
  let prev = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = new Uint8Array(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const c = prev[x];
      let v = line[x];
      if (filter === 1) v = (v + a) & 0xff;
      else if (filter === 2) v = (v + c) & 0xff;
      else if (filter === 3) v = (v + ((a + c) >> 1)) & 0xff;
      else if (filter === 4) {
        const p = a + c - (x >= bpp ? prev[x - bpp] : 0);
        const pa = Math.abs(p - a), pb = Math.abs(p - c), pc = Math.abs(p - (x >= bpp ? prev[x - bpp] : 0));
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? c : x >= bpp ? prev[x - bpp] : 0)) & 0xff;
      }
      cur[x] = v;
    }
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4, s = x * bpp;
      out[o] = cur[s];
      out[o + 1] = cur[s + 1];
      out[o + 2] = cur[s + 2];
      out[o + 3] = bpp === 4 ? cur[s + 3] : 255;
    }
    prev = cur;
  }
  return { w, h, data: out };
}

/* ------------------------------ PNG encode ------------------------------ */

/** Codifica PNG RGB (colorType 2) a partir de linhas RGB brutas. */
function encodePng(w, h, rgb) {
  const stride = w * 3;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0; // filtro None
    Buffer.from(rgb.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8 bits, RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* --------------------------- composicao do splash ----------------------- */

/** Desenha o logo (RGBA) sobre o fundo, centralizado, na altura pedida. */
function compose(srcW, srcH, src, W, H, logoMax, centroY) {
  const escala = Math.min(logoMax / srcW, logoMax / srcH);
  const lw = Math.max(1, Math.round(srcW * escala));
  const lh = Math.max(1, Math.round(srcH * escala));
  const x0 = Math.round((W - lw) / 2);
  const y0 = Math.round(centroY * H - lh / 2);
  const rgb = new Uint8Array(W * H * 3);
  for (let y = 0; y < H; y++) {
    const f = FUNDO;
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 3;
      rgb[o] = f[0]; rgb[o + 1] = f[1]; rgb[o + 2] = f[2];
    }
  }
  for (let y = 0; y < lh; y++) {
    const sy = Math.min(srcH - 1, (y / escala) | 0);
    for (let x = 0; x < lw; x++) {
      const sx = Math.min(srcW - 1, (x / escala) | 0);
      const s = (sy * srcW + sx) * 4;
      const alfa = src[s + 3] / 255;
      if (alfa === 0) continue;
      const d = ((y + y0) * W + (x + x0)) * 3;
      rgb[d] = Math.round(src[s] * alfa + rgb[d] * (1 - alfa));
      rgb[d + 1] = Math.round(src[s + 1] * alfa + rgb[d + 1] * (1 - alfa));
      rgb[d + 2] = Math.round(src[s + 2] * alfa + rgb[d + 2] * (1 - alfa));
    }
  }
  return rgb;
}

/* --------------------------------- aparelhos ---------------------------- */

/*
 * Modelos suportados: (device-width, device-height, dpr) em CSS px, conforme
 * os media queries que o Safari aceita para apple-touch-startup-image.
 * Largura/altura de PIXELS = css * dpr. Paisagem sai com as dimensoes trocadas.
 */
const APARELHOS = [
  { w: 320, h: 568, dpr: 2, nome: "SE 1/2/3 · 5/6/7/8" },            // 640x1136
  { w: 375, h: 667, dpr: 2, nome: "8 · SE 2/3 · 6/7" },               // 750x1334
  { w: 375, h: 812, dpr: 3, nome: "X/XS/11 Pro/12 mini/13 mini" },    // 1125x2436
  { w: 390, h: 844, dpr: 3, nome: "12/13/14 · X12Pro" },              // 1170x2532
  { w: 393, h: 852, dpr: 3, nome: "14 Pro/15/16" },                   // 1179x2556
  { w: 414, h: 736, dpr: 3, nome: "8 Plus/7 Plus" },                  // 1242x2208
  { w: 414, h: 896, dpr: 2, nome: "11/XR" },                          // 828x1792
  { w: 414, h: 896, dpr: 3, nome: "11 Pro Max/XS Max" },              // 1242x2688
  { w: 428, h: 926, dpr: 3, nome: "12/13 Pro Max/14 Plus" },          // 1284x2778
  { w: 430, h: 932, dpr: 3, nome: "14/15/16 Pro Max · 15 Plus" },     // 1290x2796
  { w: 440, h: 956, dpr: 3, nome: "16 Pro Max" },                     // 1320x2868
];

fs.mkdirSync(OUT_DIR, { recursive: true });

const { w: sw, h: sh, data } = decodePng(SRC);
const gerados = [];
let soma = 0;

for (const a of APARELHOS) {
  const pw = a.w * a.dpr, ph = a.h * a.dpr;
  const logo = Math.round(Math.min(pw, ph) * 0.3); // ~30% da menor dimensao

  // Retrato: marca um pouco acima do centro (34%), folga para a status bar
  const retrato = compose(sw, sh, data, pw, ph, logo, 0.34);
  const f1 = path.join(OUT_DIR, `apple-splash-${pw}-${ph}.png`);
  fs.writeFileSync(f1, encodePng(pw, ph, retrato));

  // Paisagem: dimensoes trocadas, marca no centro (corte do iOS na rotacao)
  const paisagem = compose(sw, sh, data, ph, pw, logo, 0.5);
  const f2 = path.join(OUT_DIR, `apple-splash-${ph}-${pw}.png`);
  fs.writeFileSync(f2, encodePng(ph, pw, paisagem));

  const kb = (fs.statSync(f1).size + fs.statSync(f2).size) / 1024;
  soma += kb;
  gerados.push(`${a.nome}: ${pw}x${ph} (${kb.toFixed(0)} kB os dois)`);
}

console.log(`Gerados ${gerados.length * 2} PNGs em public/splash (${(soma / 1024).toFixed(1)} MB no total):`);
for (const g of gerados) console.log("  - " + g);
