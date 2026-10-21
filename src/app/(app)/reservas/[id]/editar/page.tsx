import { notFound } from "next/navigation";
import { all, one } from "@/lib/db";
import { requireModule } from "@/lib/auth";
import { ehAdmin } from "@/lib/roles";
import { reservationItems } from "@/lib/reservations";
import { PageHeader } from "@/components/ui";
import ReservationForm from "../../ReservationForm";
import { updateReservation } from "../../actions";
import { sellableProducts } from "@/lib/stock";
import { preparationMinutes } from "@/lib/availability-settings";
import { CUSTOMER_PICK_COLUMNS } from "@/lib/queries";
import { activeAccounts } from "@/lib/compras";
import { getOperacao } from "@/lib/operacao-db";
import { settingsDaEmpresa } from "@/lib/settings";

export const dynamic = "force-dynamic";

export default async function EditarReservaPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireModule("reservas");
  const user = ctx.user;
  const cid = ctx.companyId;
  const { id } = await params;
  // Isolamento: reserva de outra empresa é inexistente para este usuário.
  const reservation = await one<any>(
    `SELECT r.*, (SELECT amount_cents FROM deposits d WHERE d.reservation_id = r.id AND d.company_id = r.company_id ORDER BY d.id DESC LIMIT 1) AS deposit_cents
       FROM reservations r WHERE r.id = ? AND r.company_id = ?`,
    [Number(id), cid],
  );
  if (!reservation) notFound();

  const items = (await reservationItems(reservation.id, cid)).map((i) => ({
    product_id: i.product_id,
    qty: i.qty,
    unit_price_cents: i.unit_price_cents,
    discount_cents: i.discount_cents,
    discount_expr: i.discount_expr,
  }));
  // Recompensa de fidelidade já somada ao desconto gravado: no modo % o form
  // soma por cima do percentual, para editar não engolir o benefício.
  const fidelidade = await one<any>(
    `SELECT COALESCE(SUM(used_discount_cents),0) AS cents FROM fidelity_rewards
      WHERE used_reservation_id = ? AND company_id = ? AND status = 'usada'`,
    [reservation.id, cid],
  );
  const products = await sellableProducts(cid);
  const contas = await activeAccounts(cid);
  const cfg = await settingsDaEmpresa(cid);
  const customers = await all<any>(
    `SELECT ${CUSTOMER_PICK_COLUMNS} FROM customers c WHERE c.company_id = ? AND c.active = 1 ORDER BY c.name`,
    [cid],
  );

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <PageHeader title={`Editar ${reservation.number}`} subtitle="Alterações revalidam o estoque e a agenda" />
      <ReservationForm
        preparationMinutes={await preparationMinutes()}
        action={updateReservation}
        products={products}
        customers={customers}
        reservation={reservation}
        items={items}
        isAdmin={ehAdmin(user.role)}
        submitLabel="Salvar alterações"
        contas={contas}
        operacao={await getOperacao()}
        extensao={{
          pickupAnterior: reservation.pickup_at ?? "",
          deliveryAnterior: reservation.delivery_at ?? "",
          precoHoraCents: Number(cfg.extra_hour_price_cents) || 0,
          limiteHoras: Number(cfg.extra_hours_until_daily) || 0,
          minutos: reservation.extension_minutes ?? 0,
          cents: reservation.extension_cents ?? 0,
        }}
        fidelidadeCents={Number(fidelidade?.cents ?? 0)}
      />
    </div>
  );
}
