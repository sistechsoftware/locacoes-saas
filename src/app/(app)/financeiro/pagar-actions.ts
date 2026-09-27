"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { one } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { logAction } from "@/lib/audit";
import { money, parseMoney, today, valorValido } from "@/lib/format";
import { cancelarContaPagarManual, competenciaPadrao, criarContaPagarManual } from "@/lib/pagar";

/**
 * Acoes do lancamento manual de contas a pagar.
 *
 * Caminho de erro tao importando quanto o de sucesso: nenhuma gravacao termina
 * em silencio — ou o banco confirma e a tela avisa, ou a mensagem diz exatamente
 * o que faltou. O lancamento manual nunca toca em compra, estoque, reserva ou
 * cliente, e nunca cria saida de caixa; o pagamento continua sendo a baixa
 * existente (payEntry), que grava em expenses.
 */

/** Volta para a aba A pagar mantendo o periodo filtrado. */
function destino(fd: FormData, extra: Record<string, string>): string {
  const params = new URLSearchParams({ aba: "pagar" });
  const de = String(fd.get("de") ?? "");
  const ate = String(fd.get("ate") ?? "");
  if (de) params.set("de", de);
  if (ate) params.set("ate", ate);
  for (const [k, v] of Object.entries(extra)) if (v) params.set(k, v);
  return `/financeiro?${params}`;
}

export async function criarPagarManual(fd: FormData) {
  const user = await requireUser();
  const bruto = String(fd.get("amount") ?? "");
  const amount = parseMoney(bruto);

  const descricao = String(fd.get("descricao") ?? "").trim();
  const dataCompra = String(fd.get("purchase_date") ?? "").slice(0, 10) || today();
  const vencimento = String(fd.get("due_date") ?? "").slice(0, 10) || competenciaPadrao();
  const parcelas = Math.max(1, Math.min(60, Number(fd.get("parcelas")) || 1));
  const categoria = String(fd.get("category") ?? "").trim() || "Compras";
  const supplierId = Number(fd.get("supplier_id")) || null;
  const accountId = Number(fd.get("account_id")) || null;
  const notes = String(fd.get("notes") ?? "").trim();

  if (!descricao) redirect(destino(fd, { erro: "Informe a descrição da conta." }));
  if (!valorValido(bruto)) {
    redirect(destino(fd, { erro: `Não consegui ler o valor "${bruto.trim()}". Use por exemplo 1.234,56 ou 1234,56.` }));
  }
  if (amount <= 0) redirect(destino(fd, { erro: "Informe um valor maior que zero para lançar a conta." }));

  // valida antes de gravar: nada chega ao banco pela metade
  const preview = await criarContaPagarManual({
    descricao,
    amountCents: amount,
    purchaseDate: dataCompra,
    dueDate: vencimento,
    parcelas,
    categoria,
    supplierId,
    accountId,
    notes,
    userId: user.id,
  });
  if (preview.erro || !preview.id) {
    redirect(destino(fd, { erro: preview.erro ?? "A conta não foi gravada. Nada foi lançado; tente novamente." }));
  }

  const gravado = await one<any>(`SELECT id FROM financial_entries WHERE id = ?`, [preview.id]);
  if (!gravado) redirect(destino(fd, { erro: "A conta não foi gravada. Nada foi lançado; tente novamente." }));

  await logAction(
    user,
    "criar",
    "financeiro",
    preview.id,
    `${user.name} lançou conta a pagar manual de ${money(amount)}` +
      (parcelas > 1 ? ` em ${parcelas}x` : "") +
      (descricao ? `: ${descricao}` : ""),
  );
  revalidatePath("/financeiro");
  revalidatePath("/compras");

  // mesma regra das saidas: avisar quando o lancamento cai fora do periodo filtrado
  const de = String(fd.get("de") ?? "");
  const ate = String(fd.get("ate") ?? "");
  const foraDoPeriodo = de && ate && (vencimento < de || vencimento > ate);
  redirect(
    destino(fd, {
      ok: foraDoPeriodo
        ? `Conta de ${money(amount)} lançada com vencimento em ${vencimento.split("-").reverse().join("/")}. Ela está fora do período filtrado, por isso não aparece na lista.`
        : parcelas > 1
          ? `Conta de ${money(amount)} lançada em ${parcelas} parcelas.`
          : `Conta de ${money(amount)} lançada.`,
    }),
  );
}

export async function cancelarPagarManual(fd: FormData) {
  const user = await requireUser();
  // o id chega pelo entry_id, o mesmo campo do formulario de baixa; o value do
  // botao entra como id quando o proprio botao dispara a acao
  const id = Number(fd.get("entry_id")) || Number(fd.get("id"));
  if (!id) redirect(destino(fd, { erro: "Conta a cancelar não foi identificada." }));
  const erro = await cancelarContaPagarManual(id);

  // o registro de auditoria so afirma o que de fato aconteceu
  if (!erro) {
    await logAction(user, "cancelar", "financeiro", id, `${user.name} cancelou a conta a pagar manual #${id}`);
  }
  revalidatePath("/financeiro");
  if (erro) redirect(destino(fd, { erro }));
  redirect(destino(fd, { ok: "Conta cancelada." }));
}
