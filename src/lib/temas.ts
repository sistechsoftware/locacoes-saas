/**
 * Identidade visual por tenant — biblioteca de paletas.
 *
 * ---------------------------------------------------------------------------
 * POR QUE ESTE ARQUIVO EXISTE (resultado da auditoria de cores)
 * ---------------------------------------------------------------------------
 * O Locô já é 100% tokenizado: `@theme` do Tailwind v4 em src/app/globals.css
 * declara --color-marca-*, --color-nuvem-*, --color-tinta-*, --color-destaque-*
 * e o Tailwind EMITE os utilitários referenciando a variável
 * (`.bg-marca-600 { background-color: var(--color-marca-600) }` — verificado
 * no CSS compilado). Ou seja: retematizar o produto inteiro NÃO exige tocar em
 * nenhuma tela, basta sobrescrever as variáveis de :root.
 *
 * Foram identificadas 23 variáveis de marca, organizadas em 4 papéis:
 *
 *   marca     (10 degraus) — AÇÃO: botões, menu ativo, links, foco, FAB
 *   destaque  ( 5 degraus) — ACENTO: realces, cabeçalhos de bloco, progresso
 *   nuvem     ( 5 degraus) — SUPERFÍCIE: fundo da página, cartões, bordas
 *   tinta     ( 3 degraus) — TEXTO: rótulos, títulos, conteúdo
 *
 * As demais cores do sistema (red/emerald/amber/sky/violet = semânticas de
 * erro/sucesso/alerta/informação; stone/slate = neutros de texto secundário)
 * NÃO são personalizáveis: continuam comunicando significado independente do
 * tema escolhido. Esse desacoplamento é travado em tests/temas.test.ts.
 *
 * ---------------------------------------------------------------------------
 * COMO AS RAMPS FORAM CONSTRUÍDAS
 * ---------------------------------------------------------------------------
 * Cada rampa preserva a MESMA curva de luz (OKLCH L) da marca Locô — a
 * calibrada para AA em todos os fundos reais do produto — e troca apenas matiz
 * e croma. Alguns temas escurecem os degraus 600+ (ação) porque verde e azul
 * têm luminância maior que o laranja no mesmo L. Contraste verificado por
 * teste (WCAG 2.1 AA) para as 12 paletas.
 *
 * O tema `loco` é uma cópia literal dos hexes atuais: restaurá-lo devolve o
 * produto exatamente como é hoje, mesmo que o design original mude no futuro
 * (a fonte única é este mapa, não uma cópia no navegador).
 */

export type PapelTema = "marca" | "destaque" | "nuvem" | "tinta";

export type CoresTema = Record<PapelTema, Record<string, string>>;

export type Tema = {
  id: string;
  nome: string;
  descricao: string;
  cores: CoresTema;
};

/** Tema usado quando a empresa nunca escolheu (ou escolheu voltar ao padrão). */
export const TEMA_PADRAO = "loco";

/** Degraus de cada papel — lista única para emitir as variáveis e para testar. */
export const ESCALAS: Record<PapelTema, readonly string[]> = {
  marca: ["50", "100", "200", "300", "400", "500", "600", "700", "800", "900"],
  destaque: ["100", "300", "500", "600", "700"],
  nuvem: ["50", "100", "200", "300", "400"],
  tinta: ["700", "800", "900"],
};

/**
 * Papéis que o cliente pode personalizar. Os papéis FORA desta lista são
 * semânticos/fixos e nunca entram na sobrescrita de :root.
 */
export const PAPEIS_PERSONALIZAVEIS: readonly PapelTema[] = ["marca", "destaque", "nuvem", "tinta"];

/**
 * `--color-<papel>-<degrau>` de um tema, na ordem estável de emissão.
 * Usado pelo layout autenticado (override de :root) e pela prévia.
 */
export function variaveisDoTema(tema: Tema): Record<string, string> {
  const out: Record<string, string> = {};
  for (const papel of PAPEIS_PERSONALIZAVEIS) {
    for (const degrau of ESCALAS[papel]) {
      out[`--color-${papel}-${degrau}`] = tema.cores[papel][degrau];
    }
  }
  return out;
}

/** Só as declarações (`--color-marca-600: #BC4800;`), sem seletor. */
export function declaracoesDoTema(tema: Tema): string {
  return Object.entries(variaveisDoTema(tema))
    .map(([k, v]) => `${k}:${v};`)
    .join("");
}

/**
 * Folha de estilo que sobrescreve o tema do Tailwind em :root.
 *
 * Ela entra NO HTML da área autenticada (server component, force-dynamic),
 * depois dos stylesheets do head — mesma especificidade, ordem posterior,
 * logo vence — sem flash de cor na primeira pintura e sem hidratação
 * divergente: o cliente não calcula nada.
 */
export function cssDoTema(tema: Tema): string {
  return `:root{${declaracoesDoTema(tema)}}`;
}

/**
 * Resolve o valor gravado em company_settings para um tema conhecido.
 * Qualquer lixo (valor apagado, chave removida de uma versão futura, injeção)
 * cai no padrão — nunca lança, nunca aplica cor desconhecida.
 */
export function resolverTema(valor: unknown): Tema {
  const id = typeof valor === "string" ? valor.trim() : "";
  // hasOwnProperty em vez de TEMAS[id]: "__proto__" e "constructor" seriam
  // recuperados do protótipo e devolveriam um objeto sem id/cor nenhum.
  return temaConhecido(id) ? TEMAS[id] : TEMAS[TEMA_PADRAO];
}

/** true se o valor do banco identifica um tema realmente cadastrado. */
export function temaConhecido(valor: unknown): boolean {
  return typeof valor === "string" && Object.prototype.hasOwnProperty.call(TEMAS, valor.trim());
}

/** Contraste WCAG 2.1 entre dois HEX (#RGB ou #RRGGBB). */
export function contraste(a: string, b: string): number {
  const lum = (hex: string): number => {
    const h = hex.replace("#", "");
    const completo = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
    const canais = [0, 2, 4].map((i) => parseInt(completo.slice(i, i + 2), 16) / 255);
    const lin = canais.map((c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
    return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

/**
 * As 12 paletas. Ordenadas: primeiro o padrão do Locô, depois as demais.
 * IDs estáveis e curtos — são a CHAVE GRAVADA NO BANCO, por isso nunca mudam.
 */
export const TEMAS: Record<string, Tema> = {
  loco: {
    id: "loco",
    nome: "Locô",
    descricao: "Tema original do Locô: laranja da marca sobre creme.",
    cores: {
      /* marca-50, marca-100, marca-200, marca-300, marca-400, marca-500, marca-600, marca-700, marca-800, marca-900 */
      marca: {
        "50": "#FFF6F0",
        "100": "#FFE9D9",
        "200": "#FFD2B3",
        "300": "#FFB485",
        "400": "#FF9451",
        "500": "#FE7316",
        "600": "#BC4800",
        "700": "#A63F00",
        "800": "#7E3102",
        "900": "#5A2301",
      },
      /* destaque-100, destaque-300, destaque-500, destaque-600, destaque-700 */
      destaque: {
        "100": "#FDF1D8",
        "300": "#F9DA9A",
        "500": "#F4B942",
        "600": "#DDA22A",
        "700": "#8A6314",
      },
      /* nuvem-50, nuvem-100, nuvem-200, nuvem-300, nuvem-400 */
      nuvem: {
        "50": "#FCFBF9",
        "100": "#F6F3EC",
        "200": "#EDE8DF",
        "300": "#DED8CD",
        "400": "#B5AE9F",
      },
      /* tinta-700, tinta-800, tinta-900 */
      tinta: {
        "700": "#4A4E57",
        "800": "#2A2D34",
        "900": "#14161B",
      },
    },
  },
  "azul-corporativo": {
    id: "azul-corporativo",
    nome: "Azul Corporativo",
    descricao: "Azul institucional vivo, latão de destaque e neutros levemente frios.",
    cores: {
      /* marca-50, marca-100, marca-200, marca-300, marca-400, marca-500, marca-600, marca-700, marca-800, marca-900 */
      marca: {
        "50": "#F5F8FE",
        "100": "#E7EEFC",
        "200": "#CFDDFA",
        "300": "#B1C7F6",
        "400": "#95B3F4",
        "500": "#7CA0F0",
        "600": "#506CAC",
        "700": "#455F98",
        "800": "#344773",
        "900": "#243251",
      },
      /* destaque-100, destaque-300, destaque-500, destaque-600, destaque-700 */
      destaque: {
        "100": "#FCF0DF",
        "300": "#F7D9AD",
        "500": "#EBBB6E",
        "600": "#D3A55A",
        "700": "#836534",
      },
      /* nuvem-50, nuvem-100, nuvem-200, nuvem-300, nuvem-400 */
      nuvem: {
        "50": "#FAFBFC",
        "100": "#F1F3F6",
        "200": "#E6E9EC",
        "300": "#D5D9DD",
        "400": "#AAAFB5",
      },
      /* tinta-700, tinta-800, tinta-900 */
      tinta: {
        "700": "#474F59",
        "800": "#272E36",
        "900": "#12161C",
      },
    },
  },
  "azul-grafite": {
    id: "azul-grafite",
    nome: "Azul e Grafite",
    descricao: "Azul frio e profundo, cobre de destaque e neutros grafite.",
    cores: {
      /* marca-50, marca-100, marca-200, marca-300, marca-400, marca-500, marca-600, marca-700, marca-800, marca-900 */
      marca: {
        "50": "#F3F9FC",
        "100": "#E2F0F9",
        "200": "#C5E1F3",
        "300": "#A0CFEC",
        "400": "#78BDE6",
        "500": "#51ADE0",
        "600": "#22719A",
        "700": "#1C6387",
        "800": "#154965",
        "900": "#0C3246",
      },
      /* destaque-100, destaque-300, destaque-500, destaque-600, destaque-700 */
      destaque: {
        "100": "#FFEEE2",
        "300": "#FFD2B4",
        "500": "#FFAF7D",
        "600": "#E69969",
        "700": "#905D3E",
      },
      /* nuvem-50, nuvem-100, nuvem-200, nuvem-300, nuvem-400 */
      nuvem: {
        "50": "#FAFBFC",
        "100": "#F1F4F6",
        "200": "#E5E9EC",
        "300": "#D5D9DD",
        "400": "#AAAFB5",
      },
      /* tinta-700, tinta-800, tinta-900 */
      tinta: {
        "700": "#474F57",
        "800": "#282E34",
        "900": "#12171B",
      },
    },
  },
  "cinza-azul": {
    id: "cinza-azul",
    nome: "Cinza e Azul",
    descricao: "Ardósia acinzentada como cor de ação, com azul de destaque.",
    cores: {
      /* marca-50, marca-100, marca-200, marca-300, marca-400, marca-500, marca-600, marca-700, marca-800, marca-900 */
      marca: {
        "50": "#F5F8FA",
        "100": "#E7EFF4",
        "200": "#CEDFE9",
        "300": "#B1CCDB",
        "400": "#93BACF",
        "500": "#78AAC4",
        "600": "#4B7388",
        "700": "#416577",
        "800": "#314B5A",
        "900": "#21343F",
      },
      /* destaque-100, destaque-300, destaque-500, destaque-600, destaque-700 */
      destaque: {
        "100": "#E4F4FF",
        "300": "#BAE2FF",
        "500": "#86C9FF",
        "600": "#72B2F9",
        "700": "#446E9C",
      },
      /* nuvem-50, nuvem-100, nuvem-200, nuvem-300, nuvem-400 */
      nuvem: {
        "50": "#FAFBFC",
        "100": "#F1F4F6",
        "200": "#E5E9EC",
        "300": "#D5D9DD",
        "400": "#A9B0B4",
      },
      /* tinta-700, tinta-800, tinta-900 */
      tinta: {
        "700": "#464F59",
        "800": "#272E35",
        "900": "#12171C",
      },
    },
  },
  "verde-profissional": {
    id: "verde-profissional",
    nome: "Verde Profissional",
    descricao: "Verde institucional sóbrio com destaque âmbar.",
    cores: {
      /* marca-50, marca-100, marca-200, marca-300, marca-400, marca-500, marca-600, marca-700, marca-800, marca-900 */
      marca: {
        "50": "#F5F9F6",
        "100": "#E5F1E8",
        "200": "#CBE4D0",
        "300": "#AAD4B4",
        "400": "#89C498",
        "500": "#6AB680",
        "600": "#36744A",
        "700": "#2E653F",
        "800": "#214A2E",
        "900": "#14321D",
      },
      /* destaque-100, destaque-300, destaque-500, destaque-600, destaque-700 */
      destaque: {
        "100": "#F8F2DC",
        "300": "#EDDEA5",
        "500": "#DDC35D",
        "600": "#C6AD49",
        "700": "#7B6A29",
      },
      /* nuvem-50, nuvem-100, nuvem-200, nuvem-300, nuvem-400 */
      nuvem: {
        "50": "#FBFBFB",
        "100": "#F1F4F1",
        "200": "#E6EAE6",
        "300": "#D6DAD6",
        "400": "#ABB0AB",
      },
      /* tinta-700, tinta-800, tinta-900 */
      tinta: {
        "700": "#47514B",
        "800": "#272F2B",
        "900": "#121814",
      },
    },
  },
  "verde-petroleo": {
    id: "verde-petroleo",
    nome: "Verde e Petróleo",
    descricao: "Verde-petróleo profundo com destaque coral.",
    cores: {
      /* marca-50, marca-100, marca-200, marca-300, marca-400, marca-500, marca-600, marca-700, marca-800, marca-900 */
      marca: {
        "50": "#F4F9F8",
        "100": "#E3F1ED",
        "200": "#C7E4DC",
        "300": "#A3D3C7",
        "400": "#7DC4B3",
        "500": "#57B6A2",
        "600": "#2A7A6B",
        "700": "#236B5D",
        "800": "#1A5045",
        "900": "#113730",
      },
      /* destaque-100, destaque-300, destaque-500, destaque-600, destaque-700 */
      destaque: {
        "100": "#FFEBE2",
        "300": "#FFCCB6",
        "500": "#FFA480",
        "600": "#F48F6C",
        "700": "#995740",
      },
      /* nuvem-50, nuvem-100, nuvem-200, nuvem-300, nuvem-400 */
      nuvem: {
        "50": "#FAFBFB",
        "100": "#F0F4F4",
        "200": "#E4EAE9",
        "300": "#D4DADA",
        "400": "#A8B1B0",
      },
      /* tinta-700, tinta-800, tinta-900 */
      tinta: {
        "700": "#43514F",
        "800": "#25302E",
        "900": "#101817",
      },
    },
  },
  "esmeralda-grafite": {
    id: "esmeralda-grafite",
    nome: "Esmeralda e Grafite",
    descricao: "Esmeralda viva sobre neutros grafite, destaque em aço frio.",
    cores: {
      /* marca-50, marca-100, marca-200, marca-300, marca-400, marca-500, marca-600, marca-700, marca-800, marca-900 */
      marca: {
        "50": "#F3FAF5",
        "100": "#E2F3E7",
        "200": "#C3E6D0",
        "300": "#9DD7B3",
        "400": "#73C997",
        "500": "#45BC7E",
        "600": "#127E4D",
        "700": "#0E6E43",
        "800": "#0C5231",
        "900": "#073921",
      },
      /* destaque-100, destaque-300, destaque-500, destaque-600, destaque-700 */
      destaque: {
        "100": "#E9F4FB",
        "300": "#C8E2F4",
        "500": "#9FCBE8",
        "600": "#8AB4D0",
        "700": "#546F81",
      },
      /* nuvem-50, nuvem-100, nuvem-200, nuvem-300, nuvem-400 */
      nuvem: {
        "50": "#FAFBFC",
        "100": "#F1F4F6",
        "200": "#E6E9EC",
        "300": "#D5D9DD",
        "400": "#AAAFB4",
      },
      /* tinta-700, tinta-800, tinta-900 */
      tinta: {
        "700": "#464F59",
        "800": "#272E35",
        "900": "#12171C",
      },
    },
  },
  "roxo-sofisticado": {
    id: "roxo-sofisticado",
    nome: "Roxo Sofisticado",
    descricao: "Violeta profundo com destaque menta.",
    cores: {
      /* marca-50, marca-100, marca-200, marca-300, marca-400, marca-500, marca-600, marca-700, marca-800, marca-900 */
      marca: {
        "50": "#F8F7FE",
        "100": "#EDEBFE",
        "200": "#DCD7FC",
        "300": "#C8BEFA",
        "400": "#B5A5F9",
        "500": "#A58FF7",
        "600": "#7461B5",
        "700": "#6655A0",
        "800": "#4D4179",
        "900": "#362D57",
      },
      /* destaque-100, destaque-300, destaque-500, destaque-600, destaque-700 */
      destaque: {
        "100": "#E5F7EE",
        "300": "#BBEBD5",
        "500": "#86D8B5",
        "600": "#72C19F",
        "700": "#447761",
      },
      /* nuvem-50, nuvem-100, nuvem-200, nuvem-300, nuvem-400 */
      nuvem: {
        "50": "#FBFBFC",
        "100": "#F3F3F6",
        "200": "#E8E8ED",
        "300": "#D8D8DE",
        "400": "#AEAEB6",
      },
      /* tinta-700, tinta-800, tinta-900 */
      tinta: {
        "700": "#4D4C5A",
        "800": "#2C2C36",
        "900": "#16151C",
      },
    },
  },
  "vinho-neutros": {
    id: "vinho-neutros",
    nome: "Vinho e Neutros",
    descricao: "Bordô profundo sobre bege quente, destaque rosé.",
    cores: {
      /* marca-50, marca-100, marca-200, marca-300, marca-400, marca-500, marca-600, marca-700, marca-800, marca-900 */
      marca: {
        "50": "#FDF6F9",
        "100": "#FAE8F0",
        "200": "#F4D1E0",
        "300": "#ECB5CE",
        "400": "#E499BC",
        "500": "#DC80AD",
        "600": "#90486C",
        "700": "#7D3D5E",
        "800": "#5C2C45",
        "900": "#3F1C2D",
      },
      /* destaque-100, destaque-300, destaque-500, destaque-600, destaque-700 */
      destaque: {
        "100": "#FFEDED",
        "300": "#FFD0D0",
        "500": "#F9ADAE",
        "600": "#E09799",
        "700": "#8C5C5D",
      },
      /* nuvem-50, nuvem-100, nuvem-200, nuvem-300, nuvem-400 */
      nuvem: {
        "50": "#FCFBFA",
        "100": "#F6F3F0",
        "200": "#ECE8E4",
        "300": "#DDD8D3",
        "400": "#B4ADA7",
      },
      /* tinta-700, tinta-800, tinta-900 */
      tinta: {
        "700": "#5B484F",
        "800": "#37282E",
        "900": "#1D1316",
      },
    },
  },
  "terracota-areia": {
    id: "terracota-areia",
    nome: "Terracota e Areia",
    descricao: "Terracota vermelhosa sobre areia quente, destaque oliva.",
    cores: {
      /* marca-50, marca-100, marca-200, marca-300, marca-400, marca-500, marca-600, marca-700, marca-800, marca-900 */
      marca: {
        "50": "#FEF6F4",
        "100": "#FDE8E3",
        "200": "#FBD2C6",
        "300": "#F7B5A3",
        "400": "#F39880",
        "500": "#EE7E60",
        "600": "#AD533B",
        "700": "#994933",
        "800": "#743727",
        "900": "#53271B",
      },
      /* destaque-100, destaque-300, destaque-500, destaque-600, destaque-700 */
      destaque: {
        "100": "#F1F4E5",
        "300": "#DCE3BC",
        "500": "#C2CB8B",
        "600": "#ACB477",
        "700": "#6A6F47",
      },
      /* nuvem-50, nuvem-100, nuvem-200, nuvem-300, nuvem-400 */
      nuvem: {
        "50": "#FCFBF9",
        "100": "#F7F2EE",
        "200": "#EDE8E1",
        "300": "#DED7D0",
        "400": "#B6ADA3",
      },
      /* tinta-700, tinta-800, tinta-900 */
      tinta: {
        "700": "#5D4941",
        "800": "#382923",
        "900": "#1E130F",
      },
    },
  },
  "ambar-marinho": {
    id: "ambar-marinho",
    nome: "Âmbar e Azul-marinho",
    descricao: "Tinta e superfícies em azul-marinho, com âmbar de destaque.",
    cores: {
      /* marca-50, marca-100, marca-200, marca-300, marca-400, marca-500, marca-600, marca-700, marca-800, marca-900 */
      marca: {
        "50": "#F5F8FD",
        "100": "#E5EFFA",
        "200": "#CCDEF4",
        "300": "#ACCBED",
        "400": "#8DB7E8",
        "500": "#70A6E2",
        "600": "#325C8B",
        "700": "#294F78",
        "800": "#1B3756",
        "900": "#0D2238",
      },
      /* destaque-100, destaque-300, destaque-500, destaque-600, destaque-700 */
      destaque: {
        "100": "#FFEFDA",
        "300": "#FFD49E",
        "500": "#FFB24E",
        "600": "#E69C37",
        "700": "#905F1D",
      },
      /* nuvem-50, nuvem-100, nuvem-200, nuvem-300, nuvem-400 */
      nuvem: {
        "50": "#FAFBFC",
        "100": "#F0F4F8",
        "200": "#E4E9EF",
        "300": "#D3D9E0",
        "400": "#A8B0B9",
      },
      /* tinta-700, tinta-800, tinta-900 */
      tinta: {
        "700": "#405061",
        "800": "#222E3C",
        "900": "#0E1720",
      },
    },
  },
  "grafite-ouro": {
    id: "grafite-ouro",
    nome: "Grafite e Ouro",
    descricao: "Ação em grafite escuro com ouro de destaque — tom executivo.",
    cores: {
      /* marca-50, marca-100, marca-200, marca-300, marca-400, marca-500, marca-600, marca-700, marca-800, marca-900 */
      marca: {
        "50": "#F7F8F9",
        "100": "#EBEEF0",
        "200": "#D8DDE2",
        "300": "#C1C8D0",
        "400": "#AAB5C0",
        "500": "#97A4B2",
        "600": "#606B76",
        "700": "#545D67",
        "800": "#3E454C",
        "900": "#2A2F34",
      },
      /* destaque-100, destaque-300, destaque-500, destaque-600, destaque-700 */
      destaque: {
        "100": "#FBF2DC",
        "300": "#F3DCA5",
        "500": "#E6BF5D",
        "600": "#CEA948",
        "700": "#806828",
      },
      /* nuvem-50, nuvem-100, nuvem-200, nuvem-300, nuvem-400 */
      nuvem: {
        "50": "#FBFBFC",
        "100": "#F1F3F6",
        "200": "#E6E9EC",
        "300": "#D5D9DD",
        "400": "#AAAFB4",
      },
      /* tinta-700, tinta-800, tinta-900 */
      tinta: {
        "700": "#474F58",
        "800": "#272E35",
        "900": "#12171B",
      },
    },
  },
};

/** Lista nas telas de Configurações, na ordem acima. */
export const LISTA_TEMAS: Tema[] = Object.values(TEMAS);
