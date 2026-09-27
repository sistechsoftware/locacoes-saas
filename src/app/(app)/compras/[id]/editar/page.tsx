import { notFound } from "next/navigation";
import { all, one, scalar } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { activeAccounts, activeSuppliers, purchaseItems } from "@/lib/compras";
import { PageHeader } from "@/components/ui";
import PurchaseForm from "../../PurchaseForm";
import { updatePurchase } from "../../actions";

export const dynamic = "force-dynamic";

export default async function EditarCompraPage({ params }: { params: Promise<{ id: string }> }) {
  await requireUser();
  const { id } = await params;
  const compra = await one<any>(`SELECT * FROM purchases WHERE id = ?`, [Number(id)]);
  if (!compra) notFound();

  const [itens, produtos, fornecedores, contas, parcelas] = await Promise.all([
    purchaseItems(compra.id),
    all<any>(
      `SELECT p.id, p.code, p.name, c.name AS category FROM products p
         LEFT JOIN categories c ON c.id = p.category_id
        WHERE p.active = 1 AND p.kind <> 'kit' ORDER BY c.name, p.name`,
    ),
    activeSuppliers(),
    activeAccounts(),
    scalar<number>(`SELECT COUNT(*) FROM financial_entries WHERE purchase_id = ?`, [compra.id]),
  ]);

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <PageHeader title={`Editar ${compra.number}`} subtitle="O estoque e ajustado apenas pela diferenca" />
      <PurchaseForm
        action={updatePurchase}
        produtos={produtos}
        fornecedores={fornecedores}
        contas={contas}
        compra={compra}
        items={itens.map((i: any) => ({
          product_id: i.product_id,
          qty: i.qty,
          unit_price_cents: i.unit_price_cents,
          discount_cents: i.discount_cents,
        }))}
        parcelasIniciais={Math.max(1, parcelas)}
        submitLabel="Salvar alterações"
      />
    </div>
  );
}
