import { notFound } from "next/navigation";
import { all, one } from "@/lib/db";
import { requireModule } from "@/lib/auth";
import { quoteItems } from "@/lib/reservations";
import { PageHeader } from "@/components/ui";
import QuoteForm from "../../QuoteForm";
import { updateQuote } from "../../actions";
import { sellableProducts } from "@/lib/stock";
import { preparationMinutes } from "@/lib/availability-settings";
import { CUSTOMER_PICK_COLUMNS } from "@/lib/queries";
import { getOperacao } from "@/lib/operacao-db";
import { settingsDaEmpresa } from "@/lib/settings";

export const dynamic = "force-dynamic";

export default async function EditarOrcamentoPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireModule("orcamentos");
  const cid = ctx.companyId;
  const { id } = await params;
  // Isolamento: orçamento de outra empresa é inexistente para este usuário.
  const quote = await one<any>(`SELECT * FROM quotes WHERE id = ? AND company_id = ?`, [Number(id), cid]);
  if (!quote) notFound();
  const items = (await quoteItems(quote.id)).map((i) => ({
    product_id: i.product_id,
    qty: i.qty,
    unit_price_cents: i.unit_price_cents,
    discount_cents: i.discount_cents,
    discount_expr: i.discount_expr,
  }));
  const products = await sellableProducts(cid);
  const cfg = await settingsDaEmpresa(cid);
  const customers = await all<any>(`SELECT ${CUSTOMER_PICK_COLUMNS} FROM customers c WHERE c.company_id = ? AND c.active = 1 ORDER BY c.name`, [cid]);
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
        operacao={await getOperacao()}
        extensao={{
          pickupAnterior: quote.pickup_at ?? "",
          deliveryAnterior: quote.delivery_at ?? "",
          precoHoraCents: Number(cfg.extra_hour_price_cents) || 0,
          limiteHoras: Number(cfg.extra_hours_until_daily) || 0,
          minutos: quote.extension_minutes ?? 0,
          cents: quote.extension_cents ?? 0,
        }}
      />
    </div>
  );
}
