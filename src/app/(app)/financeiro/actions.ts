"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { all, insert, one, run, scalar } from "@/lib/db";
import { assertAdmin, requireUser } from "@/lib/auth";
import { logAction } from "@/lib/audit";
import { money, parseMoney, today, valorValido } from "@/lib/format";

/** Volta para a aba certa mantendo o periodo que o usuario estava vendo. */
function destino(fd: FormData, extra: Record<string, string>): string {
  const params = new URLSearchParams({ aba: String(fd.get("aba") ?? "saidas") });
  const de = String(fd.get("de") ?? "");
  const ate = String(fd.get("ate") ?? "");
  if (de) params.set("de", de);
  if (ate) params.set("ate", ate);
  for (const [k, v] of Object.entries(extra)) if (v) params.set(k, v);
  return `/financeiro?${params}`;
}

/**
 * Lanca uma saida.
 *
 * O caminho de erro e tao importante quanto o de sucesso: antes, um valor que o
 * sistema nao conseguia ler fazia a acao voltar calada, a pagina recarregava e
 * a pessoa ficava certa de ter salvado algo que nunca chegou ao banco. Agora
 * nenhuma saida termina em silencio: ou grava e confirma, ou diz o que houve.
 */
export async function addExpense(fd: FormData) {
  const user = await requireUser();
  const bruto = String(fd.get("amount") ?? "");
  const amount = parseMoney(bruto);

  if (!valorValido(bruto)) {
    redirect(destino(fd, { erro: `Nao consegui ler o valor "${bruto.trim()}". Use por exemplo 1.234,56 ou 1234,56.` }));
  }
  if (amount <= 0) {
    redirect(destino(fd, { erro: "Informe um valor maior que zero para lancar a saida." }));
  }

  const data = String(fd.get("date") ?? "") || today();
  const finalidade = String(fd.get("category") ?? "").trim() || "Outros";

  const id = await insert(
    `INSERT INTO expenses (date, category, description, amount_cents, method, reservation_id, status, account_id, created_by)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [
      data,
      finalidade,
      String(fd.get("description") ?? "").trim(),
      amount,
      String(fd.get("method") ?? "pix"),
      Number(fd.get("reservation_id")) || null,
      String(fd.get("status") ?? "pago"),
      Number(fd.get("account_id")) || null,
      user.id,
    ],
  );

  // so avisa sucesso depois que o banco devolve a linha: um id que nao volta,
  // ou uma leitura que nao acha o registro, e falha, nao sucesso
  const gravado = id > 0 ? await one<any>(`SELECT id, amount_cents FROM expenses WHERE id = ?`, [id]) : null;
  if (!gravado) {
    redirect(destino(fd, { erro: "A saída não foi gravada. Nada foi lançado; tente novamente." }));
  }

  await logAction(user, "criar", "despesa", id, `${user.name} lancou despesa de ${money(amount)}`);
  revalidatePath("/financeiro");

  // a listagem filtra por periodo: avisar que a saida ficou fora do filtro
  // evita a impressao de que ela nao foi salva
  const de = String(fd.get("de") ?? "");
  const ate = String(fd.get("ate") ?? "");
  const foraDoPeriodo = de && ate && (data < de || data > ate);
  redirect(
    destino(fd, {
      ok: foraDoPeriodo
        ? `Saida de ${money(amount)} lancada em ${data.split("-").reverse().join("/")}. Ela esta fora do periodo filtrado, por isso nao aparece na lista abaixo.`
        : `Saida de ${money(amount)} lancada.`,
    }),
  );
}

export async function deleteExpense(fd: FormData) {
  const user = await assertAdmin();
  const id = Number(fd.get("id"));
  const e = await one<any>(`SELECT * FROM expenses WHERE id = ?`, [id]);
  if (!e) return;
  await run(`DELETE FROM expenses WHERE id = ?`, [id]);
  await logAction(user, "excluir", "despesa", id, `${user.name} removeu despesa de ${money(e.amount_cents)}`);
  revalidatePath("/financeiro");
}

/** Lancamento avulso de entrada, sem reserva vinculada. */
export async function addIncome(fd: FormData) {
  const user = await requireUser();
  const bruto = String(fd.get("amount") ?? "");
  const amount = parseMoney(bruto);

  if (!valorValido(bruto)) {
    redirect(destino(fd, { erro: `Nao consegui ler o valor "${bruto.trim()}". Use por exemplo 1.234,56 ou 1234,56.` }));
  }
  if (amount <= 0) {
    redirect(destino(fd, { erro: "Informe um valor maior que zero para lancar a entrada." }));
  }

  const data = String(fd.get("paid_at") ?? "") || today();
  const id = await insert(
    `INSERT INTO payments (reservation_id, freight_id, amount_cents, method, paid_at, notes, account_id, created_by)
     VALUES (?,?,?,?,?,?,?,?)`,
    [
      Number(fd.get("reservation_id")) || null,
      null,
      amount,
      String(fd.get("method") ?? "pix"),
      data,
      String(fd.get("notes") ?? "").trim(),
      Number(fd.get("account_id")) || null,
      user.id,
    ],
  );

  const gravado = id > 0 ? await one<any>(`SELECT id FROM payments WHERE id = ?`, [id]) : null;
  if (!gravado) {
    redirect(destino(fd, { erro: "A entrada não foi gravada. Nada foi lançado; tente novamente." }));
  }

  await logAction(user, "criar", "pagamento", id, `${user.name} lancou entrada de ${money(amount)}`);
  revalidatePath("/financeiro");
  redirect(destino(fd, { ok: `Entrada de ${money(amount)} lancada.` }));
}

/* ------------------------------------------------------------------ */
/* Finalidades das saidas                                              */
/* ------------------------------------------------------------------ */

/**
 * Cria uma finalidade nova.
 *
 * O catalogo nao tem vinculo com os lancamentos: expenses.category guarda o
 * texto escolhido no dia, entao mexer aqui nunca altera uma saida antiga.
 */
export async function createPurpose(fd: FormData) {
  const user = await assertAdmin();
  const nome = String(fd.get("name") ?? "").replace(/\s+/g, " ").trim().slice(0, 60);

  if (!nome) redirect(destino(fd, { erro: "Informe o nome da finalidade." }));

  const existente = await one<any>(`SELECT id, name, active FROM expense_purposes WHERE lower(name) = lower(?)`, [nome]);
  if (existente) {
    // ja existia desativada: reativar e melhor que recusar, que e o que a
    // pessoa esta querendo fazer de fato
    if (!existente.active) {
      await run(`UPDATE expense_purposes SET active = 1, updated_at = datetime('now','localtime') WHERE id = ?`, [
        existente.id,
      ]);
      await logAction(user, "editar", "configuracao", existente.id, `${user.name} reativou a finalidade "${existente.name}"`);
      revalidatePath("/financeiro");
      redirect(destino(fd, { nova: existente.name, ok: `Finalidade "${existente.name}" reativada.` }));
    }
    redirect(destino(fd, { erro: `A finalidade "${existente.name}" ja existe.`, nova: existente.name }));
  }

  const id = await insert(`INSERT INTO expense_purposes (name, created_by) VALUES (?,?)`, [nome, user.id]);
  await logAction(user, "criar", "configuracao", id, `${user.name} criou a finalidade de saida "${nome}"`);
  revalidatePath("/financeiro");
  revalidatePath("/configuracoes");
  redirect(destino(fd, { nova: nome, ok: `Finalidade "${nome}" criada e ja selecionada.` }));
}

/** Liga e desliga a finalidade sem tocar em lancamento nenhum. */
export async function togglePurpose(fd: FormData) {
  const user = await assertAdmin();
  const id = Number(fd.get("id"));
  const p = await one<any>(`SELECT * FROM expense_purposes WHERE id = ?`, [id]);
  if (!p) return;
  const novo = p.active ? 0 : 1;
  await run(`UPDATE expense_purposes SET active = ?, updated_at = datetime('now','localtime') WHERE id = ?`, [novo, id]);
  await logAction(
    user,
    "editar",
    "configuracao",
    id,
    `${user.name} ${novo ? "reativou" : "desativou"} a finalidade "${p.name}"`,
  );
  revalidatePath("/financeiro");
  revalidatePath("/configuracoes");
}

/**
 * Renomeia a finalidade.
 *
 * As saidas ja lancadas continuam com o texto antigo, de proposito: mudar o
 * nome do catalogo nao pode reescrever o que foi registrado no passado.
 */
export async function renamePurpose(fd: FormData) {
  const user = await assertAdmin();
  const id = Number(fd.get("id"));
  const nome = String(fd.get("name") ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
  const p = await one<any>(`SELECT * FROM expense_purposes WHERE id = ?`, [id]);
  if (!p || !nome || nome === p.name) return;

  const conflito = await one<any>(
    `SELECT id FROM expense_purposes WHERE lower(name) = lower(?) AND id <> ?`,
    [nome, id],
  );
  if (conflito) {
    redirect(`/configuracoes?aba=finalidades&erro=${encodeURIComponent(`Ja existe a finalidade "${nome}".`)}`);
  }

  await run(`UPDATE expense_purposes SET name = ?, updated_at = datetime('now','localtime') WHERE id = ?`, [nome, id]);
  await logAction(user, "editar", "configuracao", id, `${user.name} renomeou a finalidade "${p.name}" para "${nome}"`);
  revalidatePath("/financeiro");
  revalidatePath("/configuracoes");
}

/** Finalidades para escolher, mais as usadas no historico que sairam do catalogo. */
export async function finalidadesDisponiveis(selecionada?: string): Promise<string[]> {
  const ativas = await all<{ name: string }>(
    `SELECT name FROM expense_purposes WHERE active = 1 ORDER BY name COLLATE NOCASE`,
  );
  const nomes = ativas.map((p) => p.name);
  if (selecionada && !nomes.some((n) => n.toLowerCase() === selecionada.toLowerCase())) nomes.unshift(selecionada);
  return nomes;
}

export async function todasFinalidades() {
  return await all<any>(
    `SELECT p.*, (SELECT COUNT(*) FROM expenses e WHERE lower(e.category) = lower(p.name)) AS usos
       FROM expense_purposes p ORDER BY p.active DESC, p.name COLLATE NOCASE`,
  );
}
