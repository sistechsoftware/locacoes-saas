"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { insert, one, run } from "@/lib/db";
import { assertAdmin } from "@/lib/auth";
import { logAction } from "@/lib/audit";
import { parseMoney } from "@/lib/format";
import { conflitaCom, temErro, validarFaixas, type Faixa } from "@/lib/promocoes";
import { promocoesDoProduto } from "@/lib/promocoes-db";

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

function lerData(fd: FormData, campo: string): string | null {
  const valor = String(fd.get(campo) ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(valor) ? valor : null;
}

async function validar(fd: FormData, productId: number, faixas: Faixa[], exceto?: number): Promise<string | null> {
  if (!productId) return "Escolha o produto da promoção.";

  const problemas = validarFaixas(faixas);
  if (temErro(problemas)) {
    return problemas.filter((p) => p.tipo === "erro").map((p) => p.mensagem).join(" ");
  }

  const inicio = lerData(fd, "starts_on");
  const fim = lerData(fd, "ends_on");
  if (inicio && fim && fim < inicio) return "A data final não pode ser anterior à data inicial.";

  // duas promocoes valendo para a mesma quantidade deixariam o preco a sorte da
  // ordem da consulta; melhor recusar e deixar o operador decidir
  if (String(fd.get("active") ?? "") === "1") {
    const outras = await promocoesDoProduto(productId, exceto);
    const conflito = conflitaCom({ starts_on: inicio, ends_on: fim, tiers: faixas }, outras);
    if (conflito) return conflito;
  }
  return null;
}

async function gravarFaixas(promotionId: number, faixas: Faixa[]) {
  await run(`DELETE FROM promotion_tiers WHERE promotion_id = ?`, [promotionId]);
  for (const f of faixas) {
    await insert(
      `INSERT INTO promotion_tiers (promotion_id, min_qty, max_qty, unit_price_cents) VALUES (?,?,?,?)`,
      [promotionId, f.min_qty, f.max_qty, f.unit_price_cents],
    );
  }
}

export async function createPromotion(_prev: string | null, fd: FormData): Promise<string | null> {
  const user = await assertAdmin();
  const productId = Number(fd.get("product_id"));
  const faixas = lerFaixas(fd);
  const erro = await validar(fd, productId, faixas);
  if (erro) return erro;

  const id = await insert(
    `INSERT INTO promotions (product_id, name, active, starts_on, ends_on, notes, created_by)
     VALUES (?,?,?,?,?,?,?)`,
    [
      productId,
      String(fd.get("name") ?? "").trim().slice(0, 120),
      String(fd.get("active") ?? "") === "1" ? 1 : 0,
      lerData(fd, "starts_on"),
      lerData(fd, "ends_on"),
      String(fd.get("notes") ?? "").trim().slice(0, 500) || null,
      user.id,
    ],
  );
  await gravarFaixas(id, faixas);
  await logAction(user, "criar", "promocao", id, `${user.name} criou uma promoção por quantidade`);
  revalidatePath("/promocoes");
  redirect(`/promocoes/${id}`);
}

export async function updatePromotion(_prev: string | null, fd: FormData): Promise<string | null> {
  const user = await assertAdmin();
  const id = Number(fd.get("id"));
  const productId = Number(fd.get("product_id"));
  const faixas = lerFaixas(fd);
  const erro = await validar(fd, productId, faixas, id);
  if (erro) return erro;

  await run(
    `UPDATE promotions SET product_id=?, name=?, active=?, starts_on=?, ends_on=?, notes=?,
            updated_at=datetime('now','localtime') WHERE id=?`,
    [
      productId,
      String(fd.get("name") ?? "").trim().slice(0, 120),
      String(fd.get("active") ?? "") === "1" ? 1 : 0,
      lerData(fd, "starts_on"),
      lerData(fd, "ends_on"),
      String(fd.get("notes") ?? "").trim().slice(0, 500) || null,
      id,
    ],
  );
  await gravarFaixas(id, faixas);
  // documentos ja salvos guardam o proprio preco: mudar a promocao nao mexe neles
  await logAction(user, "editar", "promocao", id, `${user.name} alterou a promoção`);
  revalidatePath("/promocoes");
  revalidatePath(`/promocoes/${id}`);
  redirect(`/promocoes/${id}`);
}

export async function togglePromotion(fd: FormData) {
  const user = await assertAdmin();
  const id = Number(fd.get("id"));
  const promocao = await one<any>(`SELECT active FROM promotions WHERE id = ?`, [id]);
  if (!promocao) return;
  const novo = promocao.active ? 0 : 1;
  await run(`UPDATE promotions SET active=?, updated_at=datetime('now','localtime') WHERE id=?`, [novo, id]);
  await logAction(user, "editar", "promocao", id, `${user.name} ${novo ? "ativou" : "desativou"} a promoção`);
  revalidatePath("/promocoes");
  revalidatePath(`/promocoes/${id}`);
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
    `SELECT pr.id, p.name AS product_name FROM promotions pr JOIN products p ON p.id = pr.product_id WHERE pr.id = ?`,
    [id],
  );
  if (!promocao) return;
  await run(`DELETE FROM promotions WHERE id = ?`, [id]);
  await logAction(user, "excluir", "promocao", id, `${user.name} excluiu a promoção de ${promocao.product_name}`);
  revalidatePath("/promocoes");
  redirect("/promocoes");
}
