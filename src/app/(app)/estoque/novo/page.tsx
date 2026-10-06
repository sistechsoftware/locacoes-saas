import { all } from "@/lib/db";
import { requireModule } from "@/lib/auth";
import { Card, PageHeader } from "@/components/ui";
import ProductForm from "../ProductForm";
import { createProduct } from "../actions";

export const dynamic = "force-dynamic";

export default async function NovoProdutoPage() {
  const ctx = await requireModule("estoque");
  const cid = ctx.companyId;
  const categories = await all<any>(`SELECT id, name FROM categories WHERE company_id = ? AND active = 1 ORDER BY name`, [cid]);
  const simpleProducts = await all<any>(
    `SELECT id, name, code, total_qty, rent_price_cents FROM products
      WHERE company_id = ? AND active = 1 AND kind <> 'kit' ORDER BY name`,
    [cid],
  );
  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <PageHeader title="Novo Produto" subtitle="Produto simples ou kit composto" />
      <Card>
        <ProductForm action={createProduct} categories={categories} simpleProducts={simpleProducts} />
      </Card>
    </div>
  );
}
