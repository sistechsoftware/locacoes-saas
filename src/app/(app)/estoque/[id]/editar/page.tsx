import { notFound } from "next/navigation";
import { all, one } from "@/lib/db";
import { requireModule } from "@/lib/auth";
import { Card, PageHeader } from "@/components/ui";
import ProductForm from "../../ProductForm";
import { updateProduct } from "../../actions";

export const dynamic = "force-dynamic";

export default async function EditarProdutoPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireModule("estoque");
  const cid = ctx.companyId;
  const { id } = await params;
  // Isolamento: produto de outra empresa é inexistente para este usuário.
  const product = await one<any>(`SELECT * FROM products WHERE id = ? AND company_id = ?`, [Number(id), cid]);
  if (!product) notFound();

  const categories = await all<any>(`SELECT id, name FROM categories WHERE company_id = ? AND active = 1 ORDER BY name`, [cid]);
  const simpleProducts = await all<any>(
    `SELECT id, name, code, total_qty, rent_price_cents FROM products
      WHERE company_id = ? AND active = 1 AND kind <> 'kit' ORDER BY name`,
    [cid],
  );
  const components = await all<any>(
    `SELECT component_product_id AS product_id, quantity FROM product_components WHERE parent_product_id = ? AND company_id = ?`,
    [product.id, cid],
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
