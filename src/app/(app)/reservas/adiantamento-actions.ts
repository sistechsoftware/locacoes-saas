"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { one } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { logAction } from "@/lib/audit";
import { money, parseMoney, today } from "@/lib/format";
import {
  adiantamentoAberto,
  atualizarAdiantamentoAgendado,
  cancelarAdiantamentoAgendado,
  confirmarAdiantamento,
  criarAdiantamento,
} from "@/lib/receber";

/**
 * Adiantamento gerenciado na tela da reserva.
 *
 * As duas op financeiras de verdade — dinheiro entrando e previsao criada —
 * ja existem no sistema (payments e financial_entries); estas acoes so
 * validam a entrada do formulario e chamam as funcoes de receber.ts, do
 * mesmo jeito que parcelarReserva/receberParcela ja fazem para o
 * parcelamento comum.
 */
export async function criarAdiantamentoAction(fd: FormData) {
  const user = await requireUser();
  const reservationId = Number(fd.get("reservation_id"));
  const imediato = String(fd.get("type") ?? "agendado") === "agora";

  const erro = await criarAdiantamento({
    reservationId,
    amountCents: parseMoney(String(fd.get("amount") ?? "")),
    imediato,
    dataPrevista: String(fd.get("date") ?? "") || today(),
    method: String(fd.get("method") ?? "pix"),
    accountId: Number(fd.get("account_id")) || null,
    userId: user.id,
  });

  if (!erro) {
    const r = await one<any>(`SELECT number FROM reservations WHERE id = ?`, [reservationId]);
    await logAction(
      user,
      "criar",
      "reserva",
      reservationId,
      imediato
        ? `${user.name} registrou um adiantamento recebido na reserva ${r?.number}`
        : `${user.name} agendou um adiantamento na reserva ${r?.number}`,
    );
  }
  revalidatePath(`/reservas/${reservationId}`);
  revalidatePath("/financeiro");
  revalidatePath("/dashboard");
  if (erro) redirect(`/reservas/${reservationId}?erro=${encodeURIComponent(erro)}`);
}

export async function atualizarAdiantamentoAction(fd: FormData) {
  const user = await requireUser();
  const entryId = Number(fd.get("entry_id"));
  const reservationId = Number(fd.get("reservation_id"));

  const erro = await atualizarAdiantamentoAgendado(entryId, {
    amountCents: parseMoney(String(fd.get("amount") ?? "")),
    dataPrevista: String(fd.get("date") ?? ""),
    method: String(fd.get("method") ?? "pix"),
    userId: user.id,
  });

  if (!erro) {
    await logAction(user, "editar", "reserva", reservationId, `${user.name} alterou o adiantamento agendado`);
  }
  revalidatePath(`/reservas/${reservationId}`);
  revalidatePath("/financeiro");
  revalidatePath("/dashboard");
  if (erro) redirect(`/reservas/${reservationId}?erro=${encodeURIComponent(erro)}`);
}

export async function confirmarAdiantamentoAction(fd: FormData) {
  const user = await requireUser();
  const entryId = Number(fd.get("entry_id"));
  const reservationId = Number(fd.get("reservation_id"));

  const erro = await confirmarAdiantamento(entryId, {
    method: String(fd.get("method") ?? "") || undefined,
    paidAt: String(fd.get("paid_at") ?? "") || today(),
    accountId: Number(fd.get("account_id")) || null,
    userId: user.id,
  });

  if (!erro) {
    const entry = await one<any>(`SELECT amount_cents FROM financial_entries WHERE id = ?`, [entryId]);
    const r = await one<any>(`SELECT number FROM reservations WHERE id = ?`, [reservationId]);
    await logAction(
      user,
      "recebimento",
      "reserva",
      reservationId,
      `${user.name} confirmou o adiantamento de ${money(entry?.amount_cents ?? 0)} na reserva ${r?.number}`,
    );
  }
  revalidatePath(`/reservas/${reservationId}`);
  revalidatePath("/financeiro");
  revalidatePath("/dashboard");
  if (erro) redirect(`/reservas/${reservationId}?erro=${encodeURIComponent(erro)}`);
}

export async function cancelarAdiantamentoAction(fd: FormData) {
  const user = await requireUser();
  const entryId = Number(fd.get("entry_id"));
  const reservationId = Number(fd.get("reservation_id"));

  const cancelou = await cancelarAdiantamentoAgendado(entryId);
  if (cancelou) {
    await logAction(user, "editar", "reserva", reservationId, `${user.name} cancelou o adiantamento agendado`);
  }
  revalidatePath(`/reservas/${reservationId}`);
  revalidatePath("/financeiro");
  revalidatePath("/dashboard");
}

/** Usado pela tela para saber se ja existe um adiantamento em aberto, sem duplicar a consulta. */
export async function temAdiantamentoAberto(reservationId: number) {
  return (await adiantamentoAberto(reservationId)) ?? null;
}
