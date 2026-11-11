"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { insert, one, run, scalar } from "@/lib/db";
import { assertAdmin, PermissionError, requireModuleEdit } from "@/lib/auth";
import { logAction } from "@/lib/audit";
import { gerarRecebiveis } from "@/lib/receber";
import { estornarPagamento } from "@/lib/estornos";
import { money, parseMoney, today } from "@/lib/format";

/** Cria as parcelas a receber de uma reserva. */
export async function parcelarReserva(fd: FormData) {
  const { user } = await requireModuleEdit("financeiro");
  const reservationId = Number(fd.get("reservation_id"));
  const erro = await gerarRecebiveis(
    { tipo: "locacao", reservationId },
    {
      parcelas: Math.max(1, Math.min(60, Number(fd.get("parcelas")) || 1)),
      primeiroVencimento: String(fd.get("primeiro_vencimento") ?? "") || today(),
      accountId: Number(fd.get("account_id")) || null,
      userId: user.id,
    },
  );
  if (!erro) {
    await logAction(user, "editar", "reserva", reservationId, `${user.name} gerou as contas a receber da reserva`);
  }
  revalidatePath(`/reservas/${reservationId}`);
  revalidatePath("/financeiro");
  if (erro) redirect(`/reservas/${reservationId}?erro=${encodeURIComponent(erro)}`);
}

/** Cria as parcelas a receber de um frete. */
export async function parcelarFrete(fd: FormData) {
  const { user } = await requireModuleEdit("financeiro");
  const freightId = Number(fd.get("freight_id"));
  const erro = await gerarRecebiveis(
    { tipo: "frete", freightId },
    {
      parcelas: Math.max(1, Math.min(60, Number(fd.get("parcelas")) || 1)),
      primeiroVencimento: String(fd.get("primeiro_vencimento") ?? "") || today(),
      accountId: Number(fd.get("account_id")) || null,
      userId: user.id,
    },
  );
  if (!erro) {
    await logAction(user, "editar", "frete", freightId, `${user.name} gerou as contas a receber do frete`);
  }
  revalidatePath(`/fretes/${freightId}`);
  revalidatePath("/financeiro");
  if (erro) redirect(`/fretes/${freightId}?erro=${encodeURIComponent(erro)}`);
}

/**
 * Registra a entrada de caixa de uma parcela a receber.
 *
 * O lancamento vai para payments, que continua sendo o unico livro de entradas,
 * ligado a parcela pelo entry_id. A parcela nao guarda "valor recebido": ele e
 * a soma destes lancamentos.
 */
export async function receberParcela(fd: FormData) {
  const { user } = await requireModuleEdit("financeiro");
  const entryId = Number(fd.get("entry_id"));
  const valor = parseMoney(String(fd.get("amount") ?? ""));
  // Isolamento: parcela de outra empresa é "não encontrada".
  const entry = await one<any>(`SELECT * FROM financial_entries WHERE id = ? AND company_id = ?`, [entryId, user.company_id]);
  if (!entry) return;

  const destino = entry.reservation_id
    ? `/reservas/${entry.reservation_id}`
    : entry.freight_id
      ? `/fretes/${entry.freight_id}`
      : "/financeiro?aba=receber";
  if (valor <= 0) redirect(`${destino}?erro=${encodeURIComponent("Informe um valor válido.")}`);

  await insert(
    `INSERT INTO payments (reservation_id, freight_id, amount_cents, method, paid_at, notes, entry_id, account_id, created_by, company_id)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [
      entry.reservation_id,
      entry.freight_id,
      valor,
      String(fd.get("method") ?? "pix"),
      String(fd.get("paid_at") ?? "") || today(),
      entry.description,
      entryId,
      Number(fd.get("account_id")) || entry.account_id,
      user.id,
      user.company_id,
    ],
  );

  const recebido = await scalar<number>(`SELECT COALESCE(SUM(amount_cents),0) FROM payments WHERE entry_id = ?`, [
    entryId,
  ]);
  if (recebido >= entry.amount_cents) {
    await run(`UPDATE financial_entries SET status = 'quitada' WHERE id = ? AND company_id = ?`, [entryId, user.company_id]);
  }

  await logAction(
    user,
    "recebimento",
    "financeiro",
    entryId,
    `${user.name} recebeu ${money(valor)} da parcela ${entry.number}`,
  );
  revalidatePath(destino);
  revalidatePath("/financeiro");
}

/**
 * Estorna um recebimento mantendo o registro do estorno.
 *
 * Mesma operação da tela da reserva (ver @/lib/estornos): a devolução é uma
 * linha negativa ligada ao recebimento original, com trava de estorno
 * duplicado no banco e status da parcela recalculado no mesmo batch. Antes
 * este caminho duplicava a regra e permitia estornar duas vezes o mesmo
 * lançamento.
 */
export async function estornarRecebimento(fd: FormData) {
  const user = await assertAdmin();
  const paymentId = Number(fd.get("payment_id"));
  const r = await estornarPagamento({ paymentId, companyId: user.company_id, userId: user.id });
  // Contrato histórico: lado de transferência é recusado como permissão.
  if ("erro" in r && r.codigo === "transferencia") throw new PermissionError(r.erro);
  if ("erro" in r) redirect(`/financeiro?erro=${encodeURIComponent(r.erro)}`);

  await logAction(
    user,
    "estorno",
    "financeiro",
    r.reservationId ?? paymentId,
    `${user.name} estornou um recebimento de ${money(r.valorCents)}`,
  );
  revalidatePath("/financeiro");
  if (r.reservationId) revalidatePath(`/reservas/${r.reservationId}`);
  if (r.freightId) revalidatePath(`/fretes/${r.freightId}`);
}
