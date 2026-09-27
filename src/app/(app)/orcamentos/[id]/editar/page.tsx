import { notFound } from "next/navigation";
import { all, one } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { quoteItems } from "@/lib/reservations";
import { PageHeader } from "@/components/ui";
import QuoteForm from "../../QuoteForm";
import { updateQuote } from "../../actions";
import { sellableProducts } from "@/lib/stock";
import { preparationMinutes } from "@/lib/availability-settings";
import { CUSTOMER_PICK_COLUMNS } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function EditarOrcamentoPage({ params }: { params: Promise<{ id: string }> }) {
  await requireUser();
  const { id } = await params;
  const quote = await one<any>(`SELECT * FROM quotes WHERE id = ?`, [Number(id)]);
  if (!quote) notFound();
  const items = (await quoteItems(quote.id)).map((i) => ({
    product_id: i.product_id,
    qty: i.qty,
    unit_price_cents: i.unit_price_cents,
    discount_cents: i.discount_cents,
  }));
  const products = await sellableProducts();
  const customers = await all<any>(`SELECT ${CUSTOMER_PICK_COLUMNS} FROM customers c WHERE c.active = 1 ORDER BY c.name`);
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <PageHeader title={`Editar ${quote.number}`} />
      <QuoteForm
        preparationMinutes={await preparationMinutes()}
        action={updateQuote}
        products={products}
        customers={customers}
        quote={quote}
        items={items}
        submitLabel="Salvar Alterações"
      />
    </div>
  );
}
