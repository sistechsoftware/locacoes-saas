import { all } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { Card, PageHeader } from "@/components/ui";
import ProductForm from "../ProductForm";
import { createProduct } from "../actions";

export const dynamic = "force-dynamic";

export default async function NovoProdutoPage() {
  await requireUser();
  const categories = await all<any>(`SELECT id, name FROM categories WHERE active = 1 ORDER BY name`);
  const simpleProducts = await all<any>(
    `SELECT id, name, code, total_qty, rent_price_cents FROM products
      WHERE active = 1 AND kind <> 'kit' ORDER BY name`,
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
