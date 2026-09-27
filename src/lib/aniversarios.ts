/**
 * Aniversarios de clientes.
 *
 * O que importa para o aniversario e o dia e o mes; o ano serve para a idade e
 * so aparece quando foi cadastrado. Toda a conta e feita em UTC sobre a data
 * pura (YYYY-MM-DD), sem passar por Date local, porque data de nascimento nao
 * tem hora e qualquer conversao de fuso a empurraria um dia para tras.
 *
 * Este arquivo nao acessa banco: e a regra, e regra precisa ser testavel
 * sozinha.
 */

/** Data pura, sem hora. Aceita "1990-09-15" e "1990-09-15T00:00". */
export function partes(data: string | null | undefined): { ano: number; mes: number; dia: number } | null {
  if (!data) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(data));
  if (!m) return null;
  const ano = +m[1];
  const mes = +m[2];
  const dia = +m[3];
  if (mes < 1 || mes > 12 || dia < 1 || dia > 31) return null;
  // recusa 31/02 e parecidos: o calendario e quem decide se a data existe
  const d = new Date(Date.UTC(ano, mes - 1, dia));
  if (d.getUTCMonth() !== mes - 1 || d.getUTCDate() !== dia) return null;
  return { ano, mes, dia };
}

export const valida = (data: string | null | undefined) => partes(data) !== null;

/** "MM-DD", que e como o aniversario e comparado no banco. */
export function diaMes(data: string | null | undefined): string | null {
  const p = partes(data);
  return p ? `${String(p.mes).padStart(2, "0")}-${String(p.dia).padStart(2, "0")}` : null;
}

const bissexto = (ano: number) => (ano % 4 === 0 && ano % 100 !== 0) || ano % 400 === 0;

/**
 * Quando o aniversario cai em um dado ano.
 *
 * Nascido em 29/02, num ano comum a comemoracao fica em 28/02: adiantar mantem
 * a festa dentro do mes de nascimento, que e como as pessoas tratam a data.
 */
export function aniversarioNoAno(data: string, ano: number): string | null {
  const p = partes(data);
  if (!p) return null;
  const dia = p.mes === 2 && p.dia === 29 && !bissexto(ano) ? 28 : p.dia;
  return `${ano}-${String(p.mes).padStart(2, "0")}-${String(dia).padStart(2, "0")}`;
}

const emDias = (iso: string) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 86400000;

/**
 * Quantos dias faltam para o proximo aniversario. Hoje e 0.
 *
 * Vira o ano sozinho: em 29/12, um aniversario de 02/01 esta a 4 dias, nao a
 * 361 no passado.
 */
export function diasAte(nascimento: string, hojeISO: string): number | null {
  const p = partes(nascimento);
  const hoje = partes(hojeISO);
  if (!p || !hoje) return null;

  const desteAno = aniversarioNoAno(nascimento, hoje.ano)!;
  const diff = emDias(desteAno) - emDias(hojeISO.slice(0, 10));
  if (diff >= 0) return diff;
  const proximo = aniversarioNoAno(nascimento, hoje.ano + 1)!;
  return emDias(proximo) - emDias(hojeISO.slice(0, 10));
}

export const fazAniversarioHoje = (nascimento: string, hojeISO: string) => diasAte(nascimento, hojeISO) === 0;

/**
 * Idade completa hoje.
 *
 * Subtrair os anos nao basta: quem nasceu em dezembro ainda nao fez aniversario
 * em setembro, e diria um ano a mais. Devolve null quando o ano nao foi
 * cadastrado ou nao faz sentido.
 */
export function idade(nascimento: string, hojeISO: string): number | null {
  const p = partes(nascimento);
  const hoje = partes(hojeISO);
  if (!p || !hoje) return null;
  let anos = hoje.ano - p.ano;
  const jaFez = hoje.mes > p.mes || (hoje.mes === p.mes && hoje.dia >= p.dia);
  if (!jaFez) anos--;
  return anos >= 0 && anos <= 130 ? anos : null;
}

/** Idade que a pessoa completa no proximo aniversario. */
export function idadeQueCompleta(nascimento: string, hojeISO: string): number | null {
  const atual = idade(nascimento, hojeISO);
  if (atual === null) return null;
  return fazAniversarioHoje(nascimento, hojeISO) ? atual : atual + 1;
}

/**
 * Os "MM-DD" de uma janela a partir de hoje, ja virando o ano.
 *
 * A consulta filtra por esta lista em vez de varrer a tabela inteira, e por
 * isso a busca continua barata mesmo com a base grande.
 */
export function janela(hojeISO: string, dias: number): string[] {
  const hoje = partes(hojeISO);
  if (!hoje) return [];
  const total = Math.max(0, Math.min(366, Math.trunc(dias)));
  const base = Date.UTC(hoje.ano, hoje.mes - 1, hoje.dia);
  const saida: string[] = [];
  for (let i = 0; i <= total; i++) {
    const d = new Date(base + i * 86400000);
    const md = `${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
    if (!saida.includes(md)) saida.push(md);
    // 28/02 tambem cobre quem nasceu em 29/02, quando o ano nao e bissexto
    if (md === "02-28" && !bissexto(d.getUTCFullYear()) && !saida.includes("02-29")) saida.push("02-29");
  }
  return saida;
}

/** Todos os "MM-DD" de um mes, para a visao mensal. */
export function diasDoMes(ano: number, mes: number): string[] {
  const total = new Date(Date.UTC(ano, mes, 0)).getUTCDate();
  return Array.from({ length: total }, (_, i) => `${String(mes).padStart(2, "0")}-${String(i + 1).padStart(2, "0")}`);
}

/* ------------------------------------------------------------------ */
/* Avisos                                                              */
/* ------------------------------------------------------------------ */

export type TipoAviso = "hoje" | "proximo";

/**
 * Chave que impede o aviso repetido.
 *
 * Inclui a data do aniversario, entao a rotina pode rodar dez vezes no mesmo
 * dia sem gerar dez avisos, e no ano seguinte o aviso volta normalmente.
 */
export function chaveAviso(tipo: TipoAviso, customerId: number, dataAniversario: string): string {
  return `aniversario:${tipo}:${customerId}:${dataAniversario.slice(0, 10)}`;
}

/** Texto do aviso interno. Nao expõe a data de nascimento, so o necessario. */
export function textoAviso(
  tipo: TipoAviso,
  nomes: string[],
  dias = 0,
): { title: string; body: string } {
  if (tipo === "hoje") {
    const lista = listar(nomes);
    return {
      title: nomes.length === 1 ? "Aniversariante de hoje" : `Aniversariantes de hoje (${nomes.length})`,
      body: nomes.length === 1 ? `Hoje é aniversario de ${lista}.` : `Hoje é aniversario de ${lista}.`,
    };
  }
  const quando = dias === 1 ? "amanhã" : `em ${dias} dias`;
  return {
    title: "Aniversário próximo",
    body: nomes.length === 1 ? `${nomes[0]} faz aniversário ${quando}.` : `${listar(nomes)} fazem aniversário ${quando}.`,
  };
}

/** "Joao", "Joao e Maria", "Joao, Maria e mais 2". */
export function listar(nomes: string[], limite = 3): string {
  const primeiros = nomes.slice(0, limite);
  const resto = nomes.length - primeiros.length;
  const base =
    primeiros.length <= 1
      ? primeiros.join("")
      : `${primeiros.slice(0, -1).join(", ")} e ${primeiros.at(-1)}`;
  return resto > 0 ? `${base} e mais ${resto}` : base;
}

/** Primeiro nome, que e como se fala com o cliente. */
export const primeiroNome = (nome: string) => String(nome ?? "").trim().split(/\s+/)[0] ?? "";

export const MODELO_PARABENS =
  "Feliz aniversário, {cliente_nome}! Toda a equipe da {empresa_nome} deseja um dia muito especial. Conte com a gente na sua próxima festa!";
