import { notFound } from "next/navigation";
import { all, one } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { Card, PageHeader } from "@/components/ui";
import FreightForm from "../../FreightForm";
import { updateFreight } from "../../actions";
import { CUSTOMER_PICK_COLUMNS } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function EditarFretePage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  // Isolamento: frete de outra empresa é inexistente para este usuário.
  const freight = await one<any>(`SELECT * FROM freights WHERE id = ? AND company_id = ?`, [Number(id), user.company_id]);
  if (!freight) notFound();
  const customers = await all<any>(`SELECT ${CUSTOMER_PICK_COLUMNS} FROM customers c WHERE c.active = 1 ORDER BY c.name`);
  const vehicles = await all<any>(`SELECT id, name FROM vehicles WHERE active = 1 ORDER BY name`);
  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <PageHeader title={`Editar ${freight.number}`} />
      <Card>
        <FreightForm
          action={updateFreight}
          customers={customers}
          vehicles={vehicles}
          freight={freight}
          submitLabel="Salvar Alterações"
        />
      </Card>
    </div>
  );
}
