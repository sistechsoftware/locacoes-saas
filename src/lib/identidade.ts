/**
 * Identidade de acesso — tipo de pessoa, CPF/CNPJ e e-mail.
 *
 * Módulo PURO (sem db/*, sem next/*): é importado pelos formulários do
 * cliente (máscaras) e pelo backend (validação real). A barreira de segurança
 * nunca é a máscara da tela — o servidor roda estas mesmas funções.
 *
 * Regras:
 *  * documento é gravado SOMENTE com dígitos (11 = CPF, 14 = CNPJ);
 *  * e-mail é gravado normalizado (trim + minúsculas);
 *  * validação de dígito verificador brasileira (Receita) para CPF e CNPJ,
 *    recusando sequências repetidas (000...111...).
 */

export type TipoPessoa = "pf" | "pj";

const EMAIL_RX = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Somente dígitos — normalização de CPF/CNPJ/telefone digitado. */
export function somenteDigitos(v: unknown): string {
  return String(v ?? "").replace(/\D/g, "");
}

/** E-mail normalizado para gravação e comparação (trim + minúsculas). */
export function normalizarEmail(v: unknown): string {
  return String(v ?? "").trim().toLowerCase().slice(0, 120);
}

export function emailValido(v: unknown): boolean {
  const email = String(v ?? "").trim();
  return email.length > 0 && email.length <= 120 && EMAIL_RX.test(email);
}

/** Aceita os rótulos do formulário (pf/pj/PF/PJ/pessoa física...) — sem acento. */
export function tipoPessoaValido(v: unknown): TipoPessoa | null {
  const t = String(v ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  if (t === "pf" || t === "pj") return t;
  if (t === "fisica" || t === "pessoa fisica" || t === "pessoa_fisica") return "pf";
  if (t === "juridica" || t === "pessoa juridica" || t === "pessoa_juridica") return "pj";
  return null;
}

function digitoVerificador(base: string, pesos: number[]): number {
  const soma = base.split("").reduce((acc, d, i) => acc + Number(d) * pesos[i], 0);
  const resto = soma % 11;
  return resto < 2 ? 0 : 11 - resto;
}

/** CPF: 11 dígitos, dígitos verificadores conferem, sem sequência repetida. */
export function cpfValido(valor: unknown): boolean {
  const doc = somenteDigitos(valor);
  if (doc.length !== 11 || /^(\d)\1{10}$/.test(doc)) return false;
  return (
    digitoVerificador(doc.slice(0, 9), [10, 9, 8, 7, 6, 5, 4, 3, 2]) === Number(doc[9]) &&
    digitoVerificador(doc.slice(0, 10), [11, 10, 9, 8, 7, 6, 5, 4, 3, 2]) === Number(doc[10])
  );
}

/** CNPJ: 14 dígitos, dígitos verificadores conferem, sem sequência repetida. */
export function cnpjValido(valor: unknown): boolean {
  const doc = somenteDigitos(valor);
  if (doc.length !== 14 || /^(\d)\1{13}$/.test(doc)) return false;
  return (
    digitoVerificador(doc.slice(0, 12), [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]) === Number(doc[12]) &&
    digitoVerificador(doc.slice(0, 13), [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]) === Number(doc[13])
  );
}

export type ResultadoDocumento = { ok: true; documento: string } | { ok: false; erro: string };

/**
 * Valida o documento CONTRA o tipo de pessoa escolhido: PF exige CPF válido,
 * PJ exige CNPJ válido. Devolve o documento normalizado (só dígitos) — é isto
 * que vai para o banco e para o lookup de login.
 */
export function documentoDoTipo(tipo: TipoPessoa | null, valor: unknown): ResultadoDocumento {
  if (tipo !== "pf" && tipo !== "pj") {
    return { ok: false, erro: "Selecione o tipo de pessoa (Física ou Jurídica)." };
  }
  const doc = somenteDigitos(valor);
  if (tipo === "pf") {
    if (doc.length !== 11) return { ok: false, erro: "Informe o CPF com 11 dígitos." };
    if (!cpfValido(doc)) return { ok: false, erro: "CPF inválido — confira os números digitados." };
    return { ok: true, documento: doc };
  }
  if (doc.length !== 14) return { ok: false, erro: "Informe o CNPJ com 14 dígitos." };
  if (!cnpjValido(doc)) return { ok: false, erro: "CNPJ inválido — confira os números digitados." };
  return { ok: true, documento: doc };
}

/* --------------------------- classificação --------------------------- */

export type TipoIdentificador = "email" | "documento" | "usuario";

/**
 * Classifica o que foi digitado no login/recuperação, sem perguntar ao usuário:
 * contém "@" -> e-mail; só dígitos/máscara com 11 ou 14 -> documento;
 * qualquer outra coisa -> usuário legado (compatibilidade com contas antigas).
 */
export function classificarIdentificador(valor: unknown): { tipo: TipoIdentificador; valor: string } {
  const bruto = String(valor ?? "").trim();
  if (!bruto) return { tipo: "usuario", valor: "" };
  if (bruto.includes("@")) return { tipo: "email", valor: normalizarEmail(bruto) };
  const semMascara = bruto.replace(/[.\-/ ]/g, "");
  if (/^\d+$/.test(semMascara) && (semMascara.length === 11 || semMascara.length === 14)) {
    return { tipo: "documento", valor: semMascara };
  }
  return { tipo: "usuario", valor: bruto.toLowerCase().slice(0, 120) };
}

/* ------------------------------ máscaras ------------------------------ */

/** CPF progressivo: 000.000.000-00 (máx. 14 caracteres). */
export function mascaraCpf(valor: string): string {
  const d = somenteDigitos(valor).slice(0, 11);
  if (d.length <= 3) return d;
  if (d.length <= 6) return `${d.slice(0, 3)}.${d.slice(3)}`;
  if (d.length <= 9) return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6)}`;
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
}

/** CNPJ progressivo: 00.000.000/0000-00 (máx. 18 caracteres). */
export function mascaraCnpj(valor: string): string {
  const d = somenteDigitos(valor).slice(0, 14);
  let out = d;
  if (d.length > 2) out = `${d.slice(0, 2)}.${d.slice(2)}`;
  if (d.length > 6) out = `${d.slice(0, 2)}.${d.slice(2, 5)}/${d.slice(5)}`;
  if (d.length > 10) out = `${d.slice(0, 2)}.${d.slice(2, 5)}/${d.slice(5, 9)}-${d.slice(9)}`;
  return out;
}

/** Máscara conforme o tipo — usada nos formulários enquanto o usuário digita. */
export function mascaraDocumento(tipo: TipoPessoa, valor: string): string {
  return tipo === "pf" ? mascaraCpf(valor) : mascaraCnpj(valor);
}
