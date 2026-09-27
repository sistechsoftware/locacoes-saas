import { all } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { Card, PageHeader } from "@/components/ui";
import OperationForm from "./OperationForm";
import { createOperation } from "../actions";

export const dynamic = "force-dynamic";

export default async function NovaOperacaoPage({
  searchParams,
}: {
  searchParams: Promise<{ reserva?: string; tipo?: string }>;
}) {
  await requireUser();
  const sp = await searchParams;
  const reservations = await all<any>(
    `SELECT r.id, r.number, r.event_date, c.name AS customer_name
       FROM reservations r JOIN customers c ON c.id = r.customer_id
      WHERE r.status <> 'cancelada' ORDER BY r.event_date DESC LIMIT 200`,
  );
  const vehicles = await all<any>(`SELECT id, name FROM vehicles WHERE active = 1 ORDER BY name`);
  const users = await all<{id:number;name:string}>("SELECT id,name FROM users WHERE active=1 ORDER BY name");

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <PageHeader title="Nova Operação" subtitle="Entrega, retirada, montagem ou desmontagem" />
      <Card>
        <OperationForm
          action={createOperation}
          reservations={reservations}
          vehicles={vehicles}
          users={users}
          defaultReservation={sp.reserva ? Number(sp.reserva) : undefined}
          defaultKind={sp.tipo}
        />
      </Card>
    </div>
  );
}
