import { notFound } from "next/navigation";
import { one } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { Card, PageHeader } from "@/components/ui";
import CustomerForm from "../../CustomerForm";
import { updateCustomer } from "../../actions";

export default async function EditarClientePage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  // Isolamento: cliente de outra empresa não é editável nem visível aqui (404).
  const customer = await one<any>(`SELECT * FROM customers WHERE id = ? AND company_id = ?`, [Number(id), user.company_id]);
  if (!customer) notFound();
  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <PageHeader title="Editar Cliente" subtitle={customer.name} />
      <Card>
        <CustomerForm action={updateCustomer} customer={customer} submitLabel="Salvar Alterações" />
      </Card>
    </div>
  );
}
