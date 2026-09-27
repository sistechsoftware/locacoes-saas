import { notFound } from "next/navigation";
import { all, one } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { Card, PageHeader } from "@/components/ui";
import ProductForm from "../../ProductForm";
import { updateProduct } from "../../actions";

export const dynamic = "force-dynamic";

export default async function EditarProdutoPage({ params }: { params: Promise<{ id: string }> }) {
  await requireUser();
  const { id } = await params;
  const product = await one<any>(`SELECT * FROM products WHERE id = ?`, [Number(id)]);
  if (!product) notFound();

  const categories = await all<any>(`SELECT id, name FROM categories WHERE active = 1 ORDER BY name`);
  const simpleProducts = await all<any>(
    `SELECT id, name, code, total_qty, rent_price_cents FROM products
      WHERE active = 1 AND kind <> 'kit' ORDER BY name`,
  );
  const components = await all<any>(
    `SELECT component_product_id AS product_id, quantity FROM product_components WHERE parent_product_id = ?`,
    [product.id],
  );

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <PageHeader title="Editar Produto" subtitle={product.name} />
      <Card>
        <ProductForm
          action={updateProduct}
          product={product}
          categories={categories}
          simpleProducts={simpleProducts}
          components={components}
          submitLabel="Salvar Alterações"
        />
      </Card>
    </div>
  );
}
