import { notFound } from "next/navigation";
import { all, one, scalar } from "@/lib/db";
import { requireCompanyContext } from "@/lib/auth";
import { activeAccounts, activeSuppliers, purchaseItems } from "@/lib/compras";
import { PageHeader } from "@/components/ui";
import PurchaseForm from "../../PurchaseForm";
import { updatePurchase } from "../../actions";

export const dynamic = "force-dynamic";

export default async function EditarCompraPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireCompanyContext();
  const cid = ctx.companyId;
  const { id } = await params;
  // Isolamento: compra de outra empresa é inexistente para este usuário.
  const compra = await one<any>(`SELECT * FROM purchases WHERE id = ? AND company_id = ?`, [Number(id), cid]);
  if (!compra) notFound();

  const [itens, produtos, fornecedores, contas, parcelas] = await Promise.all([
    purchaseItems(compra.id, cid),
    all<any>(
      `SELECT p.id, p.code, p.name, c.name AS category FROM products p
         LEFT JOIN categories c ON c.id = p.category_id
        WHERE p.company_id = ? AND p.active = 1 AND p.kind <> 'kit' ORDER BY c.name, p.name`,
      [cid],
    ),
    activeSuppliers(cid),
    activeAccounts(cid),
    scalar<number>(`SELECT COUNT(*) FROM financial_entries WHERE purchase_id = ? AND company_id = ?`, [compra.id, cid]),
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
