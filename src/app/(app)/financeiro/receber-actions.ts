"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { insert, one, run, scalar } from "@/lib/db";
import { assertAdmin, requireUser } from "@/lib/auth";
import { logAction } from "@/lib/audit";
import { gerarRecebiveis } from "@/lib/receber";
import { money, parseMoney, today } from "@/lib/format";

/** Cria as parcelas a receber de uma reserva. */
export async function parcelarReserva(fd: FormData) {
  const user = await requireUser();
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
  const user = await requireUser();
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
  const user = await requireUser();
  const entryId = Number(fd.get("entry_id"));
  const valor = parseMoney(String(fd.get("amount") ?? ""));
  const entry = await one<any>(`SELECT * FROM financial_entries WHERE id = ?`, [entryId]);
  if (!entry) return;

  const destino = entry.reservation_id
    ? `/reservas/${entry.reservation_id}`
    : entry.freight_id
      ? `/fretes/${entry.freight_id}`
      : "/financeiro?aba=receber";
  if (valor <= 0) redirect(`${destino}?erro=${encodeURIComponent("Informe um valor válido.")}`);

  await insert(
    `INSERT INTO payments (reservation_id, freight_id, amount_cents, method, paid_at, notes, entry_id, account_id, created_by)
     VALUES (?,?,?,?,?,?,?,?,?)`,
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
    ],
  );

  const recebido = await scalar<number>(`SELECT COALESCE(SUM(amount_cents),0) FROM payments WHERE entry_id = ?`, [
    entryId,
  ]);
  if (recebido >= entry.amount_cents) {
    await run(`UPDATE financial_entries SET status = 'quitada' WHERE id = ?`, [entryId]);
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

/** Estorna um recebimento, mantendo o registro do estorno. */
export async function estornarRecebimento(fd: FormData) {
  const user = await assertAdmin();
  const paymentId = Number(fd.get("payment_id"));
  const p = await one<any>(`SELECT * FROM payments WHERE id = ?`, [paymentId]);
  if (!p) return;

  await insert(
    `INSERT INTO payments (reservation_id, freight_id, amount_cents, method, paid_at, notes, entry_id, account_id, created_by)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [
      p.reservation_id,
      p.freight_id,
      -p.amount_cents,
      p.method,
      today(),
      `Estorno: ${p.notes ?? ""}`.trim(),
      p.entry_id,
      p.account_id,
      user.id,
    ],
  );
  if (p.entry_id) await run(`UPDATE financial_entries SET status = 'aberta' WHERE id = ?`, [p.entry_id]);

  await logAction(
    user,
    "estorno",
    "financeiro",
    p.entry_id ?? paymentId,
    `${user.name} estornou um recebimento de ${money(p.amount_cents)}`,
  );
  revalidatePath("/financeiro");
  if (p.reservation_id) revalidatePath(`/reservas/${p.reservation_id}`);
  if (p.freight_id) revalidatePath(`/fretes/${p.freight_id}`);
}
