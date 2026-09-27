import { all } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { Card, PageHeader } from "@/components/ui";
import FreightForm from "../FreightForm";
import { createFreight } from "../actions";
import { CUSTOMER_PICK_COLUMNS } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function NovoFretePage({
  searchParams,
}: {
  searchParams: Promise<{ valor?: string }>;
}) {
  await requireUser();
  // valor vindo da calculadora de frete, quando o usuario clica em usar
  const { valor } = await searchParams;
  const customers = await all<any>(`SELECT ${CUSTOMER_PICK_COLUMNS} FROM customers c WHERE c.active = 1 ORDER BY c.name`);
  const vehicles = await all<any>(`SELECT id, name FROM vehicles WHERE active = 1 ORDER BY name`);
  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <PageHeader title="Novo Frete" subtitle="Serviço de transporte avulso" />
      <Card>
        <FreightForm action={createFreight} customers={customers} vehicles={vehicles} valorInicial={valor} />
      </Card>
    </div>
  );
}
