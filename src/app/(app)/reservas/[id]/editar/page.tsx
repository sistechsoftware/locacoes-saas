import { notFound } from "next/navigation";
import { all, one } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { reservationItems } from "@/lib/reservations";
import { PageHeader } from "@/components/ui";
import ReservationForm from "../../ReservationForm";
import { updateReservation } from "../../actions";
import { sellableProducts } from "@/lib/stock";
import { preparationMinutes } from "@/lib/availability-settings";
import { CUSTOMER_PICK_COLUMNS } from "@/lib/queries";
import { activeAccounts } from "@/lib/compras";

export const dynamic = "force-dynamic";

export default async function EditarReservaPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const reservation = await one<any>(
    `SELECT r.*, (SELECT amount_cents FROM deposits d WHERE d.reservation_id = r.id ORDER BY d.id DESC LIMIT 1) AS deposit_cents
       FROM reservations r WHERE r.id = ?`,
    [Number(id)],
  );
  if (!reservation) notFound();

  const items = (await reservationItems(reservation.id)).map((i) => ({
    product_id: i.product_id,
    qty: i.qty,
    unit_price_cents: i.unit_price_cents,
    discount_cents: i.discount_cents,
  }));
  const products = await sellableProducts();
  const contas = await activeAccounts();
  const customers = await all<any>(
    `SELECT ${CUSTOMER_PICK_COLUMNS} FROM customers c WHERE c.active = 1 ORDER BY c.name`,
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
        isAdmin={user.role === "admin"}
        submitLabel="Salvar alterações"
        contas={contas}
      />
    </div>
  );
}
