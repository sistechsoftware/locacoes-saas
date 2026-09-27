import { requireUser } from "@/lib/auth";
import { Card, PageHeader } from "@/components/ui";
import CustomerForm from "../CustomerForm";
import { createCustomer } from "../actions";

export default async function NovoClientePage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  await requireUser();
  const { next } = await searchParams;
  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <PageHeader title="Novo Cliente" subtitle="Cadastro básico para reservas e orçamentos" />
      <Card>
        <CustomerForm action={createCustomer} next={next} />
      </Card>
    </div>
  );
}
