/**
 * Assinatura virtual de contratos: token, estado e integridade.
 *
 * O token e o unico segredo que separa o contrato de um cliente do contrato de
 * outro, entao ele e tratado como senha: gerado com aleatoriedade forte, nunca
 * gravado em texto, e comparado pelo hash. Trocar caracteres na URL nao pode
 * abrir o contrato de ninguem.
 *
 * Este arquivo nao acessa banco, para a regra ser testavel sozinha.
 */

export type EstadoAssinatura = "pendente" | "assinado" | "revogado";

export type Assinatura = {
  status: EstadoAssinatura;
  expires_at: string | null;
  revoked_at: string | null;
  signed_at: string | null;
};

/** Por que o link nao pode ser usado, ou null quando esta tudo certo. */
export type Impedimento = "assinado" | "revogado" | "expirado" | null;

export function impedimento(a: Assinatura, agoraISO: string): Impedimento {
  if (a.status === "assinado" || a.signed_at) return "assinado";
  if (a.status === "revogado" || a.revoked_at) return "revogado";
  if (a.expires_at && agoraISO.slice(0, 19) > a.expires_at.slice(0, 19)) return "expirado";
  return null;
}

export const podeAssinar = (a: Assinatura, agoraISO: string) => impedimento(a, agoraISO) === null;

export const MENSAGEM_IMPEDIMENTO: Record<Exclude<Impedimento, null>, string> = {
  assinado: "Este contrato já foi assinado. Não é possível assinar de novo.",
  revogado: "Este link foi cancelado pela empresa. Fale com a gente para receber um novo.",
  expirado: "Este link expirou. Fale com a gente para receber um novo.",
};

/* ------------------------------------------------------------------ */
/* Token                                                               */
/* ------------------------------------------------------------------ */

/** Alfabeto sem caracteres que se confundem ao ler ou ditar. */
const ALFABETO = "abcdefghijkmnopqrstuvwxyzACDEFGHJKLMNPQRSTUVWXYZ2345679";

/**
 * Token de 32 caracteres, sorteado do gerador criptografico.
 *
 * Sao ~180 bits de entropia: adivinhar por tentativa esta fora de alcance,
 * mesmo sem limite de requisicoes. O id sequencial do contrato nunca entra
 * aqui, justamente para nao existir vizinho previsivel.
 */
export function gerarToken(tamanho = 32): string {
  const bytes = new Uint8Array(tamanho);
  crypto.getRandomValues(bytes);
  let saida = "";
  for (const b of bytes) saida += ALFABETO[b % ALFABETO.length];
  return saida;
}

export const TOKEN_VALIDO = /^[a-zA-Z0-9]{16,64}$/;

/** SHA-256 em hexadecimal, usado para guardar o token e o documento. */
export async function sha256(texto: string): Promise<string> {
  const dados = new TextEncoder().encode(texto);
  const resumo = await crypto.subtle.digest("SHA-256", dados);
  return [...new Uint8Array(resumo)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Impressao digital do documento assinado.
 *
 * Junta o texto congelado com a assinatura e a data. Guardar isso permite
 * provar depois que o arquivo guardado e exatamente o que foi assinado, e nao
 * uma versao editada.
 */
export async function hashDocumento(partes: {
  body: string;
  signerName: string;
  signedAt: string;
  signatureRef: string;
}): Promise<string> {
  return await sha256(
    [partes.body, partes.signerName, partes.signedAt, partes.signatureRef].join("\n---\n"),
  );
}

/* ------------------------------------------------------------------ */
/* Validacao do que chega da pagina publica                            */
/* ------------------------------------------------------------------ */

/** Limite da imagem da assinatura: um desenho a dedo nao passa disso. */
export const MAX_ASSINATURA_BYTES = 400_000;

export type EntradaAssinatura = { nome: string; aceite: boolean; imagem: string };

/**
 * Confere o que a pagina publica mandou.
 *
 * Nada aqui pode confiar no navegador: o checkbox de aceite, o nome e o formato
 * da imagem sao revalidados no servidor, porque a pagina publica e o unico
 * lugar do sistema que qualquer pessoa da internet alcanca.
 */
export function validarEntrada(e: Partial<EntradaAssinatura>): string | null {
  const nome = String(e.nome ?? "").trim();
  if (nome.length < 3) return "Informe o nome de quem está assinando.";
  if (nome.length > 120) return "Nome muito longo.";
  if (!e.aceite) return "É preciso marcar que leu e concorda com os termos.";

  const imagem = String(e.imagem ?? "");
  if (!imagem) return "Faça a assinatura antes de confirmar.";
  if (imagem.length > MAX_ASSINATURA_BYTES) return "Assinatura muito pesada. Tente um traço mais simples.";
  // quem decide se e uma imagem de verdade e a leitura dos bytes, nao o tamanho
  // do texto: um PNG legitimo pode ser pequeno, e um texto longo pode ser lixo
  if (!bytesDaAssinatura(imagem)) return "Assinatura inválida.";
  return null;
}

/** Converte a imagem enviada em bytes, recusando qualquer coisa fora do padrao. */
export function bytesDaAssinatura(dataUrl: string): Uint8Array | null {
  const marcador = "data:image/png;base64,";
  if (!dataUrl.startsWith(marcador)) return null;
  try {
    const base64 = dataUrl.slice(marcador.length);
    if (!/^[A-Za-z0-9+/]+=*$/.test(base64)) return null;
    const binario = atob(base64);
    const bytes = new Uint8Array(binario.length);
    for (let i = 0; i < binario.length; i++) bytes[i] = binario.charCodeAt(i);
    // PNG comeca sempre com esta assinatura de 8 bytes
    const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    return png.every((b, i) => bytes[i] === b) ? bytes : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Upload manual                                                       */
/* ------------------------------------------------------------------ */

export const MIMES_DOCUMENTO = ["application/pdf", "image/jpeg", "image/jpg", "image/png"];
export const MAX_DOCUMENTO_BYTES = 5_000_000;

export function validarDocumento(mime: string, tamanho: number): string | null {
  if (!MIMES_DOCUMENTO.includes(mime.toLowerCase())) {
    return "Formato não aceito. Envie PDF, JPG ou PNG.";
  }
  if (tamanho <= 0) return "Arquivo vazio.";
  if (tamanho > MAX_DOCUMENTO_BYTES) {
    return `Arquivo muito grande (${(tamanho / 1024 / 1024).toFixed(1)} MB). O limite é de 5 MB.`;
  }
  return null;
}
