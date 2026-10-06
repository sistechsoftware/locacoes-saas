import { all } from "@/lib/db";
import { requireModule } from "@/lib/auth";
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
  const ctx = await requireModule("fretes");
  const cid = ctx.companyId;
  // valor vindo da calculadora de frete, quando o usuario clica em usar
  const { valor } = await searchParams;
  const customers = await all<any>(`SELECT ${CUSTOMER_PICK_COLUMNS} FROM customers c WHERE c.company_id = ? AND c.active = 1 ORDER BY c.name`, [cid]);
  const vehicles = await all<any>(`SELECT id, name FROM vehicles WHERE company_id = ? AND active = 1 ORDER BY name`, [cid]);
  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <PageHeader title="Novo Frete" subtitle="Serviço de transporte avulso" />
      <Card>
        <FreightForm action={createFreight} customers={customers} vehicles={vehicles} valorInicial={valor} />
      </Card>
    </div>
  );
}
