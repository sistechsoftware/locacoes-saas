import "server-only";
import { all } from "./db";
import { tenantCompanyId } from "./tenant";
import { today } from "./format";
import { ordenar, precoPromocionalEntre, precoUnitarioEntre, type Faixa, type Promocao } from "./promocoes";

/** Empresa do contexto (sessão) ou padrão do banco (cron/testes). */
async function empresa(companyId?: number): Promise<number> {
  return companyId ?? (await tenantCompanyId());
}

/**
 * Acesso a dados das promocoes.
 *
 * Fica separado da regra (promocoes.ts) para a regra continuar testavel sem
 * banco. Tudo aqui carrega em lote: os formularios precisam da tabela inteira
 * de uma vez para recalcular preco enquanto o operador digita, e uma consulta
 * por produto seria N+1 na tela de montar reserva.
 */

export type PromocaoComProduto = Promocao & {
  name: string;
  notes: string | null;
  product_name: string;
  product_code: string;
  rent_price_cents: number;
};

function montar(linhas: any[], faixas: any[]): Map<number, PromocaoComProduto> {
  const porPromocao = new Map<number, Faixa[]>();
  for (const f of faixas) {
    const lista = porPromocao.get(f.promotion_id) ?? [];
    lista.push({ min_qty: f.min_qty, max_qty: f.max_qty, unit_price_cents: f.unit_price_cents });
    porPromocao.set(f.promotion_id, lista);
  }
  const mapa = new Map<number, PromocaoComProduto>();
  for (const p of linhas) {
    mapa.set(p.id, {
      id: p.id,
      product_id: p.product_id,
      name: p.name,
      notes: p.notes ?? null,
      active: !!p.active,
      starts_on: p.starts_on,
      ends_on: p.ends_on,
      product_name: p.product_name,
      product_code: p.product_code,
      rent_price_cents: p.rent_price_cents,
      tiers: ordenar(porPromocao.get(p.id) ?? []),
    });
  }
  return mapa;
}

const SELECT = `
  SELECT pr.*, p.name AS product_name, p.code AS product_code, p.rent_price_cents
    FROM promotions pr JOIN products p ON p.id = pr.product_id`;

/** Todas as promocoes cadastradas, para a tela de administracao. */
export async function listarPromocoes(filtro: { busca?: string; situacao?: string } = {}, companyId?: number) {
  const cid = await empresa(companyId);
  const where: string[] = ["pr.company_id = ?"];
  const params: any[] = [cid];
  if (filtro.busca) {
    where.push("(p.name LIKE ? OR p.code LIKE ? OR pr.name LIKE ?)");
    const like = `%${filtro.busca}%`;
    params.push(like, like, like);
  }
  if (filtro.situacao === "ativas") where.push("pr.active = 1");
  if (filtro.situacao === "inativas") where.push("pr.active = 0");

  const linhas = await all<any>(
    `${SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY p.name, pr.id DESC`,
    params,
  );
  const faixas = linhas.length
    ? await all<any>(
        `SELECT * FROM promotion_tiers WHERE promotion_id IN (${linhas.map(() => "?").join(",")}) ORDER BY min_qty`,
        linhas.map((l) => l.id),
      )
    : [];
  return [...montar(linhas, faixas).values()];
}

export async function getPromocao(id: number, companyId?: number): Promise<PromocaoComProduto | null> {
  const cid = await empresa(companyId);
  const linhas = await all<any>(`${SELECT} WHERE pr.id = ? AND pr.company_id = ?`, [id, cid]);
  if (linhas.length === 0) return null;
  const faixas = await all<any>(`SELECT * FROM promotion_tiers WHERE promotion_id = ? ORDER BY min_qty`, [id]);
  return montar(linhas, faixas).get(id) ?? null;
}

/** Outras promocoes do mesmo produto, para checar conflito antes de gravar. */
export async function promocoesDoProduto(productId: number, exceto?: number, companyId?: number) {
  const cid = await empresa(companyId);
  const linhas = await all<any>(
    `${SELECT} WHERE pr.company_id = ? AND pr.product_id = ? AND pr.active = 1 ${exceto ? "AND pr.id <> ?" : ""}`,
    exceto ? [cid, productId, exceto] : [cid, productId],
  );
  const faixas = linhas.length
    ? await all<any>(
        `SELECT * FROM promotion_tiers WHERE promotion_id IN (${linhas.map(() => "?").join(",")})`,
        linhas.map((l) => l.id),
      )
    : [];
  return [...montar(linhas, faixas).values()];
}

/**
 * Promocoes vigentes de cada produto na data, em duas consultas.
 *
 * Devolve a LISTA completa por produto, nao so a primeira: o cadastro recusa
 * sobreposicao de periodo E quantidade, mas aceita duas promocoes do mesmo
 * produto com periodos diferentes (meses distintos) ou faixas de quantidade
 * diferentes (1 a 4 e 5+). Guardar so a de menor id escondia a promocao certa
 * e o preco promocional nunca saia. A escolha entre elas acontece na regra
 * (precoPromocionalEntre), contra a data da locacao.
 */
export async function promocoesVigentes(dataISO: string, companyId?: number): Promise<Map<number, Promocao[]>> {
  const dia = String(dataISO ?? "").slice(0, 10);
  const cid = await empresa(companyId);
  const linhas = await all<any>(
    `${SELECT}
      WHERE pr.company_id = ? AND pr.active = 1
        AND (pr.starts_on IS NULL OR pr.starts_on <= ?)
        AND (pr.ends_on IS NULL OR pr.ends_on >= ?)
      ORDER BY pr.id`,
    [cid, dia || "", dia || ""],
  );
  const faixas = linhas.length
    ? await all<any>(
        `SELECT * FROM promotion_tiers WHERE promotion_id IN (${linhas.map(() => "?").join(",")}) ORDER BY min_qty`,
        linhas.map((l) => l.id),
      )
    : [];
  return agrupar(montar(linhas, faixas).values());
}

/**
 * Todas as promocoes ATIVAS de cada produto, SEM filtro de data — a vigencia
 * e avaliada depois, contra a data da locacao que o operador escolher.
 */
export async function promocoesAtivasAgrupadas(companyId?: number): Promise<Map<number, Promocao[]>> {
  const cid = await empresa(companyId);
  const linhas = await all<any>(`${SELECT} WHERE pr.company_id = ? AND pr.active = 1 ORDER BY pr.id`, [cid]);
  if (linhas.length === 0) return new Map();
  const faixas = await all<any>(
    `SELECT * FROM promotion_tiers WHERE promotion_id IN (${linhas.map(() => "?").join(",")}) ORDER BY min_qty`,
    linhas.map((l) => l.id),
  );
  return agrupar(montar(linhas, faixas).values());
}

/** Uma lista por produto: nenhuma promocao se perde, nenhuma e contada duas vezes. */
function agrupar(promocoes: Iterable<PromocaoComProduto>): Map<number, Promocao[]> {
  const porProduto = new Map<number, Promocao[]>();
  for (const promocao of promocoes) {
    if (promocao.tiers.length === 0) continue;
    const lista = porProduto.get(promocao.product_id) ?? [];
    lista.push(promocao);
    porProduto.set(promocao.product_id, lista);
  }
  return porProduto;
}

/**
 * SOMENTE para quem precisa de UMA promocao por produto (telas de listagem).
 *
 * Nao serve para precificar: entre duas promocoes do mesmo produto em periodos
 * ou faixas diferentes, esta funcao devolve sempre a de menor id e esconde a
 * que valeria na data da locacao. Para preco use promocoesVigentes /
 * promocoesAtivasAgrupadas com a lista inteira.
 */
export async function promocoesAtivasPorProduto(companyId?: number): Promise<Map<number, Promocao>> {
  const agrupadas = await promocoesAtivasAgrupadas(companyId);
  const porProduto = new Map<number, Promocao>();
  for (const [productId, lista] of agrupadas) {
    if (lista[0]) porProduto.set(productId, lista[0]);
  }
  return porProduto;
}

/**
 * Preco unitario que o sistema sugere para uma linha, ja considerando promocao.
 * Mesma regra usada pelo formulario; existe para quem precisar do preco no
 * servidor sem passar pela tela.
 */
export async function precoSugerido(productId: number, qty: number, dataISO: string, companyId?: number) {
  const cid = await empresa(companyId);
  const [produto] = await all<any>(`SELECT rent_price_cents FROM products WHERE id = ? AND company_id = ?`, [productId, cid]);
  const vigentes = await promocoesVigentes(dataISO, cid);
  return precoUnitarioEntre(produto?.rent_price_cents ?? 0, vigentes.get(productId) ?? [], qty, dataISO);
}

/**
 * Preco unitario que o SERVIDOR exige para a linha, segundo as promocoes.
 *
 * E a validacao das regras de negocio no backend: o valor vindo do navegador
 * e aceito apenas quando nenhuma promocao se aplica; havendo promocao vigente
 * cobrindo a quantidade na data da locacao, manda o preco promocional. Linha
 * com preco digitado a mao pelo operador (preco_manual) passa intacta — e a
 * mesma precedencia que o formulario ja usa.
 *
 * A data e sempre a da locacao/evento (nao a de criacao do documento): um
 * orcamento feito em outubro para uma locacao de novembro vale pelo preco de
 * novembro, e um orcamento feito durante a promocao para uma locacao fora da
 * vigencia nao leva desconto.
 */
export async function aplicarPromocaoNosItens<T extends {
  product_id: number;
  qty: number;
  unit_price_cents: number;
  preco_manual?: boolean | null;
}>(itens: T[], dataISO: string, companyId?: number): Promise<T[]> {
  if (!itens.length) return itens;
  const cid = await empresa(companyId);
  const dia = String(dataISO ?? "").slice(0, 10) || today();
  const vigentes = await promocoesVigentes(dia, cid);
  if (vigentes.size === 0) return itens;
  return itens.map((i) => {
    if (i.preco_manual) return i;
    const candidatas = vigentes.get(i.product_id);
    if (!candidatas?.length) return i;
    const promo = precoPromocionalEntre(candidatas, i.qty, dia);
    return promo ? { ...i, unit_price_cents: promo.unit_price_cents } : i;
  });
}
