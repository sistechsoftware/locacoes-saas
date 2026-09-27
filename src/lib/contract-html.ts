/**
 * HTML do contrato: deteccao de formato, sanitizacao e conversoes.
 *
 * O contrato atravessa muitos caminhos (modelo salvo, corpo gerado, snapshot
 * assinado, pagina publica), entao o conteudo formatado precisa de regras
 * proprias e testaveis sem banco, no mesmo espirito de assinatura.ts.
 *
 * Nao existe biblioteca de sanitizacao no projeto e o que o editor produz e
 * pequenissimo (negrito, italico, listas, alinhamento...), entao um sanitizador
 * proprio por lista branca de tags, atributos e propriedades de estilo cobre
 * exatamente o que o editor produz e nada mais: sem <script>, sem eventos
 * HTML, sem javascript:, sem URL de especie nenhuma.
 *
 * Modelos antigos em texto simples nao passam por aqui: a deteccao (veja
 * contractUsesHtml) e quem decide, e o texto puro continua seguindo o
 * caminho de sempre, byte a byte.
 */

/* ------------------------------------------------------------------ */
/* Listas brancas                                                      */
/* ------------------------------------------------------------------ */

/** Tags aceitas no contrato formatado. Tudo fora da lista e descartado, mantendo o conteudo. */
const TAGS_PERMITIDAS = new Set([
  "b", "strong", "i", "em", "u", "s", "strike", "sub", "sup",
  "br", "hr", "p", "div", "span", "ul", "ol", "li",
  "h1", "h2", "h3", "h4", "font",
]);

/** Tags cujo conteudo inteiro e descartado junto com a tag. */
const TAGS_PERIGOSAS = new Set([
  "script", "style", "iframe", "object", "embed", "noscript", "template",
  "title", "svg", "math", "form", "input", "button", "textarea", "select",
  "link", "meta", "base", "applet", "frame", "frameset", "audio", "video",
]);

/** Tags que nao fecham (autofechamento). */
const TAGS_VAZIAS = new Set(["br", "hr"]);

/**
 * Unico atributo permitido em qualquer tag da lista. Todos os outros
 * (id, class, href, onclick, on*, ...) sao descartados. O atributo style e
 * filtrado propriedade a propriedade mais abaixo.
 */
const ATRIBUTO_UNICO = "style";

/** Mapa de conversao do antigo <font size="1..7"> para px previsivel. */
const TAMANHO_FONT: Record<string, string> = {
  "1": "10px", "2": "13px", "3": "16px", "4": "18px", "5": "24px", "6": "32px", "7": "48px",
};

/**
 * Propriedades de estilo aceitas, com o formato de valor que cada uma pode
 * ter. Propriedade fora da lista ou valor fora do padrao: descartados. E isso
 * que impede url(...), javascript: e afins de chegar ao documento.
 */
const ESTILO_PERMITIDO: Record<string, RegExp> = {
  "font-weight": /^(bold|[1-9]00)$/,
  "font-style": /^italic$/,
  "text-decoration": /^(?:none|underline|line-through)(?: (?:none|underline|line-through))*$/,
  "text-decoration-line": /^(?:none|underline|line-through)(?: (?:none|underline|line-through))*$/,
  "font-size":
    /^(?:x-small|small|medium|large|x-large|xx-large|xxx-large|\d+(?:\.\d+)?px|\d+(?:\.\d+)?pt|\d+(?:\.\d+)?rem|\d{1,3}%)$/,
  "font-family": /^[^"'\\;{}<>]*$/,
  color: /^#[0-9a-fA-F]{3,8}$|^[a-zA-Z]{3,25}$/,
  "text-align": /^(?:left|right|center|justify)$/,
};

/**
 * Escapa texto cru que entra como conteudo do documento, sem tocar em
 * entidades que ja estao escapadas: o texto sai do sanitizador uma unica vez
 * escapado, e "Ana &lt;3" nao pode virar "Ana &amp;lt;3".
 */
function escaparTexto(texto: string): string {
  return String(texto)
    .replace(/&(?!(?:[a-zA-Z][a-zA-Z0-9]{1,30}|#\d{1,7}|#x[0-9a-fA-F]{1,6});)/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/* ------------------------------------------------------------------ */
/* Utilidades                                                          */
/* ------------------------------------------------------------------ */

/** Escapa texto para dentro do HTML. */
export function esc(texto: string): string {
  return String(texto)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Limita o tamanho de fonte a algo imprimivel e seguro. */
function limitarTamanho(prop: string, valor: string): string {
  const n = parseFloat(valor);
  if (!Number.isFinite(n)) return valor;
  if (prop === "font-size" && valor.endsWith("px") && n > 72) return "72px";
  if (prop === "font-size" && valor.endsWith("pt") && n > 54) return "54pt";
  if (prop === "font-size" && valor.endsWith("rem") && n > 5) return "5rem";
  if (prop === "font-size" && valor.endsWith("%") && n > 300) return "300%";
  return valor;
}

/** Recusa valores de estilo com conteudo executavel. */
function valorSuspeito(valor: string): boolean {
  const v = valor.toLowerCase();
  return (
    v.includes("javascript:") ||
    v.includes("url(") ||
    v.includes("expression(") ||
    v.includes("import") ||
    v.includes("<") ||
    v.includes(">") ||
    v.includes('"') ||
    v.includes("'") ||
    v.includes("\\") ||
    v.includes("`")
  );
}

/** Filtra o conteudo de um atributo style, propriedade por propriedade. */
function estiloSeguro(bruto: string): string {
  const partes: string[] = [];
  for (const pedaco of String(bruto ?? "").split(";")) {
    const idx = pedaco.indexOf(":");
    if (idx <= 0) continue;
    const prop = pedaco.slice(0, idx).trim().toLowerCase();
    const valor = pedaco.slice(idx + 1).trim();
    const padrao = ESTILO_PERMITIDO[prop];
    if (!padrao || !padrao.test(valor) || valorSuspeito(valor)) continue;
    partes.push(`${prop}: ${limitarTamanho(prop, valor)}`);
  }
  return partes.join("; ");
}

/** Le os atributos de uma tag bruta. Valores entre aspas ou soltos. */
function lerAtributos(bruto: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(bruto))) {
    attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? "";
  }
  return attrs;
}

/** Monta a tag de abertura sanitizada, ou vazio para descarta-la. */
function abrirTag(tag: string, attrsBrutos: string): string {
  const attrs = lerAtributos(attrsBrutos);

  // <font> do editor antigo vira <span> com estilo: saida uniforme em qualquer navegador
  if (tag === "font") {
    const estilo: string[] = [];
    const atual = estiloSeguro(attrs[ATRIBUTO_UNICO] ?? "");
    if (atual) estilo.push(atual);
    const face = attrs.face?.trim();
    if (face && !valorSuspeito(face)) estilo.push(`font-family: ${face}`);
    const cor = attrs.color?.trim();
    if (cor && (/^#[0-9a-fA-F]{3,8}$/.test(cor) || /^[a-zA-Z]{3,25}$/.test(cor))) estilo.push(`color: ${cor}`);
    const tamanho = TAMANHO_FONT[attrs.size?.trim() ?? ""];
    if (tamanho) estilo.push(`font-size: ${tamanho}`);
    return estilo.length ? `<span style="${estilo.join("; ")}">` : "<span>";
  }

  const estilo = estiloSeguro(attrs[ATRIBUTO_UNICO] ?? "");
  return estilo ? `<${tag} style="${estilo}">` : `<${tag}>`;
}

/* ------------------------------------------------------------------ */
/* Sanitizador                                                         */
/* ------------------------------------------------------------------ */

/**
 * Sanitiza um HTML de contrato.
 *
 * Lista branca de tags: o que nao e conhecido e descartado mantendo o texto
 * de dentro; script, style e companhia perdem tambem o conteudo. Tags abertas
 * sem fechamento sao fechadas no fim, e fechamentos sem abertura sao
 * ignorados, para a saida ficar sempre balanceada. Texto solto e escapado,
 * inclusive "<" que nao abre tag nenhuma.
 */
export function sanitizeContractHtml(html: string): string {
  if (!html) return "";
  if (!html.includes("<")) return escaparTexto(html);

  const low = html.toLowerCase();
  let saida = "";
  let ultimo = 0;
  const pilha: string[] = [];

  const re =
    /<!--[\s\S]*?-->|<\/([a-zA-Z][a-zA-Z0-9-]*)\s*>|<([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^"'>])*)\/?\s*>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    saida += escaparTexto(html.slice(ultimo, m.index));
    ultimo = m.index + m[0].length;

    if (m[0].startsWith("<!--")) continue; // comentario: fora

    if (m[1] !== undefined) {
      // fechamento
      const tag = m[1].toLowerCase();
      if (TAGS_PERIGOSAS.has(tag)) continue; // sobra de tag perigosa: ignora
      if (!TAGS_PERMITIDAS.has(tag)) continue;
      const pos = pilha.lastIndexOf(tag);
      if (pos === -1) continue; // fechamento sem abertura
      while (pilha.length > pos) saida += `</${pilha.pop()}>`;
      continue;
    }

    const tag = m[2].toLowerCase();
    if (TAGS_PERIGOSAS.has(tag)) {
      // descarta a tag e tudo ate o fechamento dela; sem fechamento, descarta o resto
      const fim = low.indexOf(`</${tag}`, ultimo);
      if (fim === -1) {
        ultimo = html.length;
      } else {
        const fecha = low.indexOf(">", fim);
        ultimo = fecha === -1 ? html.length : fecha + 1;
      }
      continue;
    }
    if (!TAGS_PERMITIDAS.has(tag)) continue; // desconhecida: solta a tag, mantem o conteudo

    if (TAGS_VAZIAS.has(tag)) {
      saida += `<${tag}>`;
      continue;
    }
    saida += abrirTag(tag, m[3] ?? "");
    pilha.push(tag);
  }

  saida += escaparTexto(html.slice(ultimo));
  while (pilha.length) saida += `</${pilha.pop()}>`;
  return saida;
}

/**
 * Valor de variavel ja montado por uma funcao confiavel do proprio contrato,
 * como itensParaHtml: passa pelo sanitizador sem ser escapado de novo.
 */
export type MarcaConfiavel = { marca: string };

/** Cria o valor de {{itens}} (e afins) que chega inteiro ao documento. */
export function marcaConfiavel(marca: string): MarcaConfiavel {
  return { marca };
}

/* ------------------------------------------------------------------ */
/* Deteccao de formato e conversoes                                    */
/* ------------------------------------------------------------------ */

const RE_TAG_CONHECIDA =
  /<\/?(?:b|strong|i|em|u|s|strike|sub|sup|br|hr|p|div|span|ul|ol|li|h1|h2|h3|h4|font)\b[^>]*>/i;

/**
 * O texto e um contrato formatado (HTML) ou um modelo antigo em texto puro?
 *
 * So marca HTML quando existe de fato uma tag conhecida: "preco a < vista" ou
 * um "<" solto nao convertem o modelo antigo em HTML por acidente.
 */
export function contractUsesHtml(text: string | null | undefined): boolean {
  return !!text && RE_TAG_CONHECIDA.test(text);
}

/**
 * Prepara um modelo antigo em texto puro para abrir no editor, sem alterar
 * nada no banco: escapa o texto e troca as quebras por <br>. O que o usuario
 * salvar depois disso e uma decisao dele; enquanto nao salvar, o banco
 * continua com o modelo original.
 */
export function plainTemplateToHtml(texto: string): string {
  return esc(String(texto ?? ""))
    .replace(/\r\n/g, "\n")
    .replace(/\n/g, "<br>");
}

/**
 * Lista de itens do contrato em HTML. Recebe as linhas ja montadas (mesma
 * formatacao do texto puro, sem o traco inicial) e devolve <ul> com o texto
 * de cada linha escapado.
 */
export function itensParaHtml(linhas: string[]): string {
  const validas = linhas.filter((l) => String(l ?? "").trim() !== "");
  if (!validas.length) return "";
  return `<ul>${validas.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>`;
}
