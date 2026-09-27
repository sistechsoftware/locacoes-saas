/**
 * Promocao por quantidade.
 *
 * Uma unica regra responde "produto + quantidade + data -> preco unitario", e
 * tanto o formulario quanto o servidor a consomem, para orcamento, reserva e
 * qualquer tela futura mostrarem o mesmo numero.
 *
 * O preco e o da faixa que contem a quantidade TOTAL do item, aplicado a todas
 * as unidades. Nao e progressivo: 15 kits na faixa "15+" custam 15 x R$ 10, e
 * nunca 4 x R$ 15 + 10 x R$ 13 + 1 x R$ 10.
 *
 * Este arquivo nao acessa banco de propostito: e a regra, e regra tem que ser
 * testavel sozinha.
 */

export type Faixa = {
  min_qty: number;
  /** null e "sem limite": a faixa vale para qualquer quantidade acima do minimo. */
  max_qty: number | null;
  unit_price_cents: number;
};

export type Promocao = {
  id: number;
  product_id: number;
  active: boolean;
  /** null nos dois lados significa "vale enquanto estiver ativa". */
  starts_on: string | null;
  ends_on: string | null;
  tiers: Faixa[];
};

/** Ordena por quantidade minima, que e como as faixas fazem sentido para quem le. */
export function ordenar(faixas: Faixa[]): Faixa[] {
  return [...faixas].sort((a, b) => a.min_qty - b.min_qty);
}

/**
 * A promocao vale nesta data?
 *
 * Sem periodo configurado, vale enquanto ativa. Com periodo, as bordas contam:
 * uma promocao que termina dia 30 ainda vale no dia 30.
 */
export function vigente(p: Pick<Promocao, "active" | "starts_on" | "ends_on">, dataISO: string): boolean {
  if (!p.active) return false;
  const dia = dataISO.slice(0, 10);
  if (p.starts_on && dia < p.starts_on) return false;
  if (p.ends_on && dia > p.ends_on) return false;
  return true;
}

/** A faixa que cobre esta quantidade, ou null quando nenhuma cobre. */
export function faixaPara(faixas: Faixa[], qty: number): Faixa | null {
  if (qty <= 0) return null;
  return (
    faixas.find((f) => qty >= f.min_qty && (f.max_qty === null || qty <= f.max_qty)) ?? null
  );
}

/**
 * Preco unitario promocional, ou null quando nao ha promocao aplicavel.
 *
 * Devolver null e proposital: quem chama decide o que fazer, e a resposta certa
 * e sempre "usa o preco normal do produto", nunca zero.
 */
export function precoPromocional(
  promocao: Promocao | null | undefined,
  qty: number,
  dataISO: string,
): { unit_price_cents: number; faixa: Faixa } | null {
  if (!promocao || !vigente(promocao, dataISO)) return null;
  const faixa = faixaPara(ordenar(promocao.tiers), qty);
  return faixa ? { unit_price_cents: faixa.unit_price_cents, faixa } : null;
}

/** Preco que vale para a linha: promocional quando existir, normal quando nao. */
export function precoUnitario(
  precoNormalCents: number,
  promocao: Promocao | null | undefined,
  qty: number,
  dataISO: string,
): { unit_price_cents: number; promocional: boolean; faixa: Faixa | null } {
  const promo = precoPromocional(promocao, qty, dataISO);
  if (!promo) return { unit_price_cents: precoNormalCents, promocional: false, faixa: null };
  return { unit_price_cents: promo.unit_price_cents, promocional: true, faixa: promo.faixa };
}

/** Como a faixa aparece para o operador ("15+ unidades", "5 a 14 unidades"). */
export function rotuloFaixa(f: Faixa): string {
  return f.max_qty === null ? `${f.min_qty}+ unidades` : `${f.min_qty} a ${f.max_qty} unidades`;
}

/* ------------------------------------------------------------------ */
/* Validacao                                                           */
/* ------------------------------------------------------------------ */

export type Problema = { tipo: "erro" | "aviso"; mensagem: string };

/**
 * Confere as faixas antes de gravar.
 *
 * Erro impede salvar, porque o preco ficaria ambiguo ou negativo. Lacuna e
 * apenas aviso: quantidade descoberta cai no preco normal, o que e um resultado
 * legitimo, mas quase sempre e distracao de quem cadastrou.
 */
export function validarFaixas(faixas: Faixa[]): Problema[] {
  const problemas: Problema[] = [];
  if (faixas.length === 0) return [{ tipo: "erro", mensagem: "Cadastre ao menos uma faixa de quantidade." }];

  for (const f of faixas) {
    if (!Number.isInteger(f.min_qty) || f.min_qty < 1) {
      problemas.push({ tipo: "erro", mensagem: "A quantidade mínima precisa ser um número inteiro a partir de 1." });
    }
    if (f.max_qty !== null && (!Number.isInteger(f.max_qty) || f.max_qty < 1)) {
      problemas.push({ tipo: "erro", mensagem: "A quantidade máxima precisa ser um número inteiro a partir de 1, ou sem limite." });
    }
    if (f.max_qty !== null && f.max_qty < f.min_qty) {
      problemas.push({ tipo: "erro", mensagem: `Faixa ${f.min_qty} a ${f.max_qty}: a máxima não pode ser menor que a mínima.` });
    }
    if (f.unit_price_cents < 0) {
      problemas.push({ tipo: "erro", mensagem: "O preço não pode ser negativo." });
    }
  }

  const ordenadas = ordenar(faixas);

  const semLimite = ordenadas.filter((f) => f.max_qty === null);
  if (semLimite.length > 1) {
    problemas.push({ tipo: "erro", mensagem: "Só pode existir uma faixa sem limite superior." });
  }

  for (let i = 0; i < ordenadas.length - 1; i++) {
    const atual = ordenadas[i];
    const proxima = ordenadas[i + 1];
    if (atual.max_qty === null) {
      problemas.push({
        tipo: "erro",
        mensagem: `A faixa ${atual.min_qty}+ não tem limite e cobre a faixa que começa em ${proxima.min_qty}.`,
      });
      continue;
    }
    if (atual.min_qty === proxima.min_qty && atual.max_qty === proxima.max_qty) {
      problemas.push({ tipo: "erro", mensagem: `Faixa ${rotuloFaixa(atual)} está duplicada.` });
      continue;
    }
    if (proxima.min_qty <= atual.max_qty) {
      problemas.push({
        tipo: "erro",
        mensagem: `As faixas ${rotuloFaixa(atual)} e ${rotuloFaixa(proxima)} se sobrepõem: a quantidade ${proxima.min_qty} teria dois preços.`,
      });
      continue;
    }
    if (proxima.min_qty > atual.max_qty + 1) {
      const inicio = atual.max_qty + 1;
      const fim = proxima.min_qty - 1;
      problemas.push({
        tipo: "aviso",
        mensagem:
          inicio === fim
            ? `A quantidade ${inicio} ficou sem promoção e usará o preço normal.`
            : `As quantidades de ${inicio} a ${fim} ficaram sem promoção e usarão o preço normal.`,
      });
    }
  }

  const menor = ordenadas[0];
  if (menor && menor.min_qty > 1) {
    const fim = menor.min_qty - 1;
    problemas.push({
      tipo: "aviso",
      mensagem:
        fim === 1
          ? "A quantidade 1 ficou sem promoção e usará o preço normal."
          : `As quantidades de 1 a ${fim} ficaram sem promoção e usarão o preço normal.`,
    });
  }

  return problemas;
}

export const temErro = (problemas: Problema[]) => problemas.some((p) => p.tipo === "erro");

/**
 * Duas promocoes do mesmo produto brigam pela mesma quantidade e periodo?
 *
 * Preferimos recusar o cadastro a inventar uma regra de prioridade: se duas
 * promocoes valem ao mesmo tempo para a mesma quantidade, qualquer escolha
 * automatica seria surpresa para quem cadastrou.
 */
export function conflitaCom(
  nova: Pick<Promocao, "starts_on" | "ends_on" | "tiers">,
  existentes: Pick<Promocao, "id" | "starts_on" | "ends_on" | "tiers">[],
): string | null {
  for (const outra of existentes) {
    if (!periodosSeCruzam(nova, outra)) continue;
    const quantidade = quantidadeEmComum(nova.tiers, outra.tiers);
    if (quantidade !== null) {
      return `Já existe outra promoção ativa para este produto cobrindo a quantidade ${quantidade} no mesmo período. Ajuste as faixas ou o período antes de salvar.`;
    }
  }
  return null;
}

function periodosSeCruzam(
  a: { starts_on: string | null; ends_on: string | null },
  b: { starts_on: string | null; ends_on: string | null },
): boolean {
  if (a.ends_on && b.starts_on && a.ends_on < b.starts_on) return false;
  if (b.ends_on && a.starts_on && b.ends_on < a.starts_on) return false;
  return true;
}

/** Menor quantidade coberta pelas duas listas de faixas, se houver. */
function quantidadeEmComum(a: Faixa[], b: Faixa[]): number | null {
  const limite = Math.max(
    ...a.map((f) => f.max_qty ?? f.min_qty),
    ...b.map((f) => f.max_qty ?? f.min_qty),
    1,
  );
  // basta varrer ate o maior limite explicito mais um: dali em diante o
  // comportamento das faixas sem teto ja se repete
  for (let q = 1; q <= limite + 1; q++) {
    if (faixaPara(ordenar(a), q) && faixaPara(ordenar(b), q)) return q;
  }
  return null;
}
