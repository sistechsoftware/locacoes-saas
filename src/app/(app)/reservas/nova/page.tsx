import { all } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { PageHeader } from "@/components/ui";
import ReservationForm from "../ReservationForm";
import { createReservation } from "../actions";
import { sellableProducts } from "@/lib/stock";
import { preparationMinutes } from "@/lib/availability-settings";
import { CUSTOMER_PICK_COLUMNS } from "@/lib/queries";
import { activeAccounts } from "@/lib/compras";

export const dynamic = "force-dynamic";

export default async function NovaReservaPage({
  searchParams,
}: {
  searchParams: Promise<{ cliente?: string; frete?: string }>;
}) {
  const user = await requireUser();
  const { cliente, frete } = await searchParams;

  const products = await sellableProducts();
  const contas = await activeAccounts();
  const customers = await all<any>(
    `SELECT ${CUSTOMER_PICK_COLUMNS} FROM customers c WHERE c.active = 1 ORDER BY c.name`,
  );

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <PageHeader title="Nova Reserva" subtitle="O sistema verifica o estoque automaticamente" />
      <ReservationForm
        preparationMinutes={await preparationMinutes()}
        action={createReservation}
        products={products}
        customers={customers}
        isAdmin={user.role === "admin"}
        defaultCustomerId={cliente ? Number(cliente) : undefined}
        freteInicial={frete}
        submitLabel="Criar reserva"
        contas={contas}
      />
    </div>
  );
}
