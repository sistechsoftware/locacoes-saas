import { all } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { PageHeader } from "@/components/ui";
import QuoteForm from "../QuoteForm";
import { createQuote } from "../actions";
import { sellableProducts } from "@/lib/stock";
import { preparationMinutes } from "@/lib/availability-settings";
import { CUSTOMER_PICK_COLUMNS } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function NovoOrcamentoPage({
  searchParams,
}: {
  searchParams: Promise<{ cliente?: string }>;
}) {
  await requireUser();
  const { cliente } = await searchParams;
  const products = await sellableProducts();
  const customers = await all<any>(`SELECT ${CUSTOMER_PICK_COLUMNS} FROM customers c WHERE c.active = 1 ORDER BY c.name`);
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <PageHeader title="Novo Orçamento" subtitle="Depois basta converter em reserva" />
      <QuoteForm
        preparationMinutes={await preparationMinutes()}
        action={createQuote}
        products={products}
        customers={customers}
        defaultCustomerId={cliente ? Number(cliente) : undefined}
        submitLabel="Criar Orçamento"
      />
    </div>
  );
}
