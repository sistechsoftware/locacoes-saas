"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { one } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { logAction } from "@/lib/audit";
import { money } from "@/lib/format";
import { prepararMensagem, usarRecompensa } from "@/lib/fidelidade-db";

/**
 * Aplica a recompensa de fidelidade na reserva.
 *
 * O beneficio entra pelo desconto que a reserva ja tem: nao existe um segundo
 * caminho para dinheiro sair, entao o total continua sendo calculado do mesmo
 * jeito de sempre.
 */
export async function aplicarRecompensa(fd: FormData) {
  const user = await requireUser();
  const reservationId = Number(fd.get("reservation_id"));
  const rewardId = Number(fd.get("reward_id"));

  const erro = await usarRecompensa(rewardId, reservationId, user.id);
  if (erro) redirect(`/reservas/${reservationId}?erro=${encodeURIComponent(erro)}`);

  const r = await one<any>(
    `SELECT f.used_kits, f.used_discount_cents, f.customer_id, res.number, c.name AS customer_name
       FROM fidelity_rewards f
       JOIN reservations res ON res.id = f.used_reservation_id
       JOIN customers c ON c.id = f.customer_id
      WHERE f.id = ?`,
    [rewardId],
  );
  if (r) {
    await logAction(
      user,
      "editar",
      "reserva",
      reservationId,
      `${user.name} aplicou a recompensa de fidelidade (${r.used_kits} kit(s), ${money(r.used_discount_cents)}) na reserva ${r.number}`,
    );
    await prepararMensagem(
      "uso",
      r.customer_id,
      rewardId,
      {
        cliente_nome: String(r.customer_name ?? "").split(" ")[0],
        numero_locacao: r.number,
        quantidade_kits: r.used_kits,
      },
      rewardId,
    );
  }

  revalidatePath(`/reservas/${reservationId}`);
  if (r) revalidatePath(`/clientes/${r.customer_id}`);
}
