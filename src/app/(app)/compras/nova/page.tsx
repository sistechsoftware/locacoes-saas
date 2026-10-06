import { all } from "@/lib/db";
import { requireModule } from "@/lib/auth";
import { activeAccounts, activeSuppliers } from "@/lib/compras";
import { PageHeader } from "@/components/ui";
import PurchaseForm from "../PurchaseForm";
import { createPurchase } from "../actions";

export const dynamic = "force-dynamic";

export default async function NovaCompraPage() {
  const ctx = await requireModule("compras");
  const cid = ctx.companyId;
  const [produtos, fornecedores, contas] = await Promise.all([
    all<any>(
      `SELECT p.id, p.code, p.name, c.name AS category FROM products p
         LEFT JOIN categories c ON c.id = p.category_id
        WHERE p.company_id = ? AND p.active = 1 AND p.kind <> 'kit' ORDER BY c.name, p.name`,
      [cid],
    ),
    activeSuppliers(cid),
    activeAccounts(cid),
  ]);

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <PageHeader title="Nova compra" subtitle="Registra o gasto e, se quiser, entra no estoque" />
      <PurchaseForm
        action={createPurchase}
        produtos={produtos}
        fornecedores={fornecedores}
        contas={contas}
        submitLabel="Registrar compra"
      />
    </div>
  );
}
