"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { all, insert, one, run } from "@/lib/db";
import { assertAdmin } from "@/lib/auth";
import { logAction } from "@/lib/audit";
import { parseMoney } from "@/lib/format";
import { conflitaCom, temErro, validarFaixas, type Faixa } from "@/lib/promocoes";
import { promocoesAtivasDosProdutos } from "@/lib/promocoes-db";

/**
 * Cadastro de promoções por quantidade.
 *
 * INDIVIDUAL: uma linha em `promotions` com `group_id NULL` — exatamente o
 * cadastro de antes, sem nenhuma mudança de comportamento.
 *
 * EM GRUPO: uma linha em `promotions` POR PRODUTO SELECIONADO, todas com o
 * mesmo `group_id` e a mesma configuração. Isso é de propósito: o motor de
 * preço (`lib/promocoes.ts`, `promocoesVigentes`, `preco-comercial.ts`) não
 * ganha uma segunda regra — ele continua encontrando a promoção do produto da
 * linha, com a faixa da quantidade daquele produto. Assim:
 *
 *   * a quantidade é sempre a do próprio produto (nunca somada entre produtos);
 *   * o período é avaliado por promoção, na data da locação;
 *   * produto fora da seleção não tem linha e não é afetado;
 *   * produto cadastrado depois não entra no grupo sozinho (vínculo explícito).
 */

/**
 * As faixas chegam como JSON do formulario, mas quem manda e a validacao
 * daqui: preco errado ou faixa sobreposta gravada seria preco ambiguo em
 * orcamento e reserva, e a tela nunca e garantia suficiente para isso.
 */
function lerFaixas(fd: FormData): Faixa[] {
  try {
    const bruto = JSON.parse(String(fd.get("tiers") ?? "[]"));
    return (Array.isArray(bruto) ? bruto : []).map((f: any) => ({
      min_qty: Math.trunc(Number(f.min_qty) || 0),
      max_qty:
        f.max_qty === null || f.max_qty === "" || f.max_qty === undefined
          ? null
          : Math.trunc(Number(f.max_qty) || 0),
      unit_price_cents:
        typeof f.unit_price_cents === "number" ? f.unit_price_cents : parseMoney(String(f.unit_price_cents ?? "")),
    }));
  } catch {
    return [];
  }
}

/**
 * Produtos escolhidos no formulario.
 *
 * A selecao multipla viaja em `product_ids` (JSON). Sem ele — ou com o campo
 * vazio — vale o `product_id` do seletor unico, que é o formulario de sempre.
 * Assim a promoção individual continua sendo gravada exatamente pelo mesmo
 * caminho de antes.
 */
function lerProdutos(fd: FormData): number[] {
  const bruto = fd.get("product_ids");
  if (bruto !== null && bruto !== undefined && String(bruto).trim() !== "") {
    try {
      const lista = JSON.parse(String(bruto));
      if (Array.isArray(lista)) {
        return [...new Set(lista.map((v) => Math.trunc(Number(v) || 0)).filter((n) => n > 0))];
      }
    } catch {
      // JSON invalido: cai no produto unico abaixo
    }
  }
  const unico = Math.trunc(Number(fd.get("product_id")) || 0);
  return unico > 0 ? [unico] : [];
}

function lerData(fd: FormData, campo: string): string | null {
  const valor = String(fd.get(campo) ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(valor) ? valor : null;
}

/** Campos que a promoção em grupo compartilha entre todos os produtos. */
function camposCompartilhados(fd: FormData) {
  return {
    name: String(fd.get("name") ?? "").trim().slice(0, 120),
    ativo: String(fd.get("active") ?? "") === "1" ? 1 : 0,
    inicio: lerData(fd, "starts_on"),
    fim: lerData(fd, "ends_on"),
    notes: String(fd.get("notes") ?? "").trim().slice(0, 500) || null,
  };
}

/** Nomes dos produtos da empresa; id de outra empresa simplesmente nao existe. */
async function produtosDaEmpresa(ids: number[], companyId: number): Promise<Map<number, string>> {
  if (ids.length === 0) return new Map();
  const linhas = await all<any>(
    `SELECT id, name FROM products WHERE company_id = ? AND id IN (${ids.map(() => "?").join(",")})`,
    [companyId, ...ids],
  );
  return new Map<number, string>(linhas.map((l: any) => [Number(l.id), String(l.name)]));
}

async function validar(
  fd: FormData,
  produtos: number[],
  faixas: Faixa[],
  exceto: number[],
  companyId: number,
): Promise<string | null> {
  if (produtos.length === 0) return "Escolha ao menos um produto para a promoção.";

  const nomes = await produtosDaEmpresa(produtos, companyId);
  if (nomes.size !== produtos.length) return "Produto não encontrado.";

  const problemas = validarFaixas(faixas);
  if (temErro(problemas)) {
    return problemas.filter((p) => p.tipo === "erro").map((p) => p.mensagem).join(" ");
  }

  const inicio = lerData(fd, "starts_on");
  const fim = lerData(fd, "ends_on");
  if (inicio && fim && fim < inicio) return "A data final não pode ser anterior à data inicial.";

  // duas promocoes valendo para a mesma quantidade deixariam o preco a sorte da
  // ordem da consulta; melhor recusar e deixar o operador decidir. Num grupo, a
  // mensagem diz QUAL produto está em conflito.
  if (String(fd.get("active") ?? "") === "1") {
    const outras = await promocoesAtivasDosProdutos(produtos, exceto, companyId);
    for (const produtoId of produtos) {
      const conflito = conflitaCom({ starts_on: inicio, ends_on: fim, tiers: faixas }, outras.get(produtoId) ?? []);
      if (conflito) return produtos.length > 1 ? `${nomes.get(produtoId)}: ${conflito}` : conflito;
    }
  }
  return null;
}

async function gravarFaixas(promotionId: number, companyId: number, faixas: Faixa[]) {
  await run(`DELETE FROM promotion_tiers WHERE promotion_id = ?`, [promotionId]);
  for (const f of faixas) {
    await insert(
      `INSERT INTO promotion_tiers (promotion_id, min_qty, max_qty, unit_price_cents, company_id) VALUES (?,?,?,?,?)`,
      [promotionId, f.min_qty, f.max_qty, f.unit_price_cents, companyId],
    );
  }
}

/** Cria a linha de promoção de um produto (individual ou membro de grupo). */
async function inserirPromocao(
  produtoId: number,
  dados: { name: string; ativo: number; inicio: string | null; fim: string | null; notes: string | null },
  userId: number,
  companyId: number,
  groupId: number | null,
): Promise<number> {
  return await insert(
    `INSERT INTO promotions (product_id, name, active, starts_on, ends_on, notes, created_by, company_id, group_id)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [produtoId, dados.name, dados.ativo, dados.inicio, dados.fim, dados.notes, userId, companyId, groupId],
  );
}

export async function createPromotion(_prev: string | null, fd: FormData): Promise<string | null> {
  const user = await assertAdmin();
  const produtos = lerProdutos(fd);
  const faixas = lerFaixas(fd);
  const erro = await validar(fd, produtos, faixas, [], user.company_id);
  if (erro) return erro;

  const dados = camposCompartilhados(fd);

  // UM produto: caminho idêntico ao cadastro original (sem grupo).
  if (produtos.length === 1) {
    const id = await inserirPromocao(produtos[0], dados, user.id, user.company_id, null);
    await gravarFaixas(id, user.company_id, faixas);
    await logAction(user, "criar", "promocao", id, `${user.name} criou uma promoção por quantidade`);
    revalidatePath("/promocoes");
    redirect(`/promocoes/${id}`);
  }

  // VÁRIOS produtos: uma promoção por produto, todas ligadas ao mesmo grupo.
  const groupId = await insert(
    `INSERT INTO promotion_groups (name, created_by, company_id) VALUES (?,?,?)`,
    [dados.name, user.id, user.company_id],
  );
  for (const produtoId of produtos) {
    const id = await inserirPromocao(produtoId, dados, user.id, user.company_id, groupId);
    await gravarFaixas(id, user.company_id, faixas);
  }
  await logAction(
    user,
    "criar",
    "promocao_grupo",
    groupId,
    `${user.name} criou uma promoção em grupo para ${produtos.length} produtos`,
  );
  revalidatePath("/promocoes");
  redirect(`/promocoes/grupo/${groupId}`);
}

export async function updatePromotion(_prev: string | null, fd: FormData): Promise<string | null> {
  const user = await assertAdmin();
  const id = Number(fd.get("id"));
  // Isolamento: promoção de outra empresa é "não encontrada".
  const atual = await one<any>(
    `SELECT id, product_id, group_id FROM promotions WHERE id = ? AND company_id = ?`,
    [id, user.company_id],
  );
  if (!atual) return "Promoção não encontrada.";
  // Editar UM membro deixaria o grupo inconsistente; a tela do grupo é o caminho.
  if (atual.group_id) {
    return "Esta promoção faz parte de uma promoção em grupo. Abra a promoção em grupo para alterar todos os produtos de uma vez.";
  }

  const produtos = lerProdutos(fd);
  const faixas = lerFaixas(fd);
  const erro = await validar(fd, produtos, faixas, [id], user.company_id);
  if (erro) return erro;

  const dados = camposCompartilhados(fd);

  // Continua individual: mesmo UPDATE de antes.
  if (produtos.length === 1) {
    await run(
      `UPDATE promotions SET product_id=?, name=?, active=?, starts_on=?, ends_on=?, notes=?,
              updated_at=datetime('now','localtime') WHERE id=? AND company_id=?`,
      [produtos[0], dados.name, dados.ativo, dados.inicio, dados.fim, dados.notes, id, user.company_id],
    );
    await gravarFaixas(id, user.company_id, faixas);
    // documentos ja salvos guardam o proprio preco: mudar a promocao nao mexe neles
    await logAction(user, "editar", "promocao", id, `${user.name} alterou a promoção`);
    revalidatePath("/promocoes");
    revalidatePath(`/promocoes/${id}`);
    redirect(`/promocoes/${id}`);
  }

  // O operador selecionou mais produtos numa promoção individual: ela vira
  // grupo. A linha existente é reaproveitada como membro (preserva id, autoria
  // e histórico); os demais produtos ganham a linha deles. Nenhum valor é
  // tocado em documentos já salvos.
  const principal = produtos.includes(Number(atual.product_id)) ? Number(atual.product_id) : produtos[0];
  const groupId = await insert(
    `INSERT INTO promotion_groups (name, created_by, company_id) VALUES (?,?,?)`,
    [dados.name, user.id, user.company_id],
  );
  await run(
    `UPDATE promotions SET product_id=?, name=?, active=?, starts_on=?, ends_on=?, notes=?, group_id=?,
            updated_at=datetime('now','localtime') WHERE id=? AND company_id=?`,
    [principal, dados.name, dados.ativo, dados.inicio, dados.fim, dados.notes, groupId, id, user.company_id],
  );
  await gravarFaixas(id, user.company_id, faixas);
  for (const produtoId of produtos) {
    if (produtoId === principal) continue;
    const novo = await inserirPromocao(produtoId, dados, user.id, user.company_id, groupId);
    await gravarFaixas(novo, user.company_id, faixas);
  }
  await logAction(
    user,
    "criar",
    "promocao_grupo",
    groupId,
    `${user.name} transformou a promoção ${id} numa promoção em grupo (${produtos.length} produtos)`,
  );
  revalidatePath("/promocoes");
  redirect(`/promocoes/grupo/${groupId}`);
}

/**
 * Edita a promoção em grupo: campos compartilhados + lista de produtos.
 *
 * Cada produto do grupo tem a própria linha; aqui só se toca nas linhas DESTE
 * grupo. Produto removido perde a linha (volta ao preço normal); produto
 * adicionado nasce com a regra atual; produto mantido é atualizado. Promoções
 * individuais e de outros grupos não são lidas nem escritas.
 */
export async function updateGroupPromotion(_prev: string | null, fd: FormData): Promise<string | null> {
  const user = await assertAdmin();
  const groupId = Number(fd.get("group_id"));
  const grupo = await one<any>(`SELECT id FROM promotion_groups WHERE id = ? AND company_id = ?`, [
    groupId,
    user.company_id,
  ]);
  if (!grupo) return "Promoção em grupo não encontrada.";

  const membros = await all<any>(
    `SELECT id, product_id FROM promotions WHERE group_id = ? AND company_id = ?`,
    [groupId, user.company_id],
  );
  const produtos = lerProdutos(fd);
  const faixas = lerFaixas(fd);
  const erro = await validar(
    fd,
    produtos,
    faixas,
    membros.map((m: any) => Number(m.id)),
    user.company_id,
  );
  if (erro) return erro;

  const dados = camposCompartilhados(fd);
  const porProduto = new Map<number, number>(
    membros.map((m: any) => [Number(m.product_id), Number(m.id)]),
  );
  const alvo = new Set(produtos);

  // sai do grupo quem foi desmarcado
  for (const m of membros) {
    if (alvo.has(Number(m.product_id))) continue;
    await run(`DELETE FROM promotions WHERE id = ? AND company_id = ?`, [Number(m.id), user.company_id]);
  }

  // entra ou é atualizado quem está marcado
  for (const produtoId of produtos) {
    const existente = porProduto.get(produtoId);
    if (existente) {
      await run(
        `UPDATE promotions SET name=?, active=?, starts_on=?, ends_on=?, notes=?,
                updated_at=datetime('now','localtime') WHERE id=? AND company_id=?`,
        [dados.name, dados.ativo, dados.inicio, dados.fim, dados.notes, existente, user.company_id],
      );
      await gravarFaixas(existente, user.company_id, faixas);
    } else {
      const id = await inserirPromocao(produtoId, dados, user.id, user.company_id, groupId);
      await gravarFaixas(id, user.company_id, faixas);
    }
  }

  await run(`UPDATE promotion_groups SET name=?, updated_at=datetime('now','localtime') WHERE id=? AND company_id=?`, [
    dados.name,
    groupId,
    user.company_id,
  ]);
  await logAction(
    user,
    "editar",
    "promocao_grupo",
    groupId,
    `${user.name} alterou a promoção em grupo (${produtos.length} produtos)`,
  );
  revalidatePath("/promocoes");
  revalidatePath(`/promocoes/grupo/${groupId}`);
  redirect(`/promocoes/grupo/${groupId}`);
}

export async function togglePromotion(fd: FormData) {
  const user = await assertAdmin();
  const id = Number(fd.get("id"));
  const promocao = await one<any>(`SELECT active FROM promotions WHERE id = ? AND company_id = ?`, [id, user.company_id]);
  if (!promocao) return;
  const novo = promocao.active ? 0 : 1;
  await run(`UPDATE promotions SET active=?, updated_at=datetime('now','localtime') WHERE id=? AND company_id=?`, [novo, id, user.company_id]);
  await logAction(user, "editar", "promocao", id, `${user.name} ${novo ? "ativou" : "desativou"} a promoção`);
  revalidatePath("/promocoes");
  revalidatePath(`/promocoes/${id}`);
}

/** Ativa/desativa o grupo inteiro: a regra é uma só para todos os produtos. */
export async function toggleGroupPromotion(fd: FormData) {
  const user = await assertAdmin();
  const groupId = Number(fd.get("id"));
  const membros = await all<any>(`SELECT active FROM promotions WHERE group_id = ? AND company_id = ?`, [
    groupId,
    user.company_id,
  ]);
  if (membros.length === 0) return;
  const novo = membros.some((m: any) => Number(m.active)) ? 0 : 1;
  await run(
    `UPDATE promotions SET active=?, updated_at=datetime('now','localtime') WHERE group_id=? AND company_id=?`,
    [novo, groupId, user.company_id],
  );
  await logAction(
    user,
    "editar",
    "promocao_grupo",
    groupId,
    `${user.name} ${novo ? "ativou" : "desativou"} a promoção em grupo`,
  );
  revalidatePath("/promocoes");
  revalidatePath(`/promocoes/grupo/${groupId}`);
}

/**
 * Excluir e seguro aqui: a promocao nunca e referenciada por documento algum.
 * Orcamento e reserva gravam o preco na propria linha, entao apagar a regra nao
 * altera nem um valor ja registrado.
 */
export async function deletePromotion(fd: FormData) {
  const user = await assertAdmin();
  const id = Number(fd.get("id"));
  const promocao = await one<any>(
    `SELECT pr.id, pr.group_id, p.name AS product_name FROM promotions pr JOIN products p ON p.id = pr.product_id WHERE pr.id = ? AND pr.company_id = ?`,
    [id, user.company_id],
  );
  if (!promocao) return;
  // Membro de grupo é removido pela tela do grupo (onde dá para ver o conjunto).
  if (promocao.group_id) return;
  await run(`DELETE FROM promotions WHERE id = ? AND company_id = ?`, [id, user.company_id]);
  await logAction(user, "excluir", "promocao", id, `${user.name} excluiu a promoção de ${promocao.product_name}`);
  revalidatePath("/promocoes");
  redirect("/promocoes");
}

/** Exclui o grupo inteiro (todas as linhas + a identidade do grupo). */
export async function deleteGroupPromotion(fd: FormData) {
  const user = await assertAdmin();
  const groupId = Number(fd.get("id"));
  const grupo = await one<any>(`SELECT id FROM promotion_groups WHERE id = ? AND company_id = ?`, [
    groupId,
    user.company_id,
  ]);
  if (!grupo) return;
  await run(`DELETE FROM promotions WHERE group_id = ? AND company_id = ?`, [groupId, user.company_id]);
  await run(`DELETE FROM promotion_groups WHERE id = ? AND company_id = ?`, [groupId, user.company_id]);
  await logAction(user, "excluir", "promocao_grupo", groupId, `${user.name} excluiu a promoção em grupo`);
  revalidatePath("/promocoes");
  redirect("/promocoes");
}
