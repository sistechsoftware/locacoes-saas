import { notFound, redirect } from "next/navigation";
import { all, nextProductCode, one } from "@/lib/db";
import { requireModule } from "@/lib/auth";
import { canEdit } from "@/lib/roles";
import { Alerta, Card, LinkButton, PageHeader } from "@/components/ui";
import ProductForm from "../../ProductForm";
import { duplicateProduct } from "../../actions";

export const dynamic = "force-dynamic";

export default async function DuplicarProdutoPage({ params }: { params: Promise<{ id: string }> }) {
  /* company_id SEMPRE do contexto autenticado: o produto só serve de modelo
     se for desta empresa (fecha o IDOR por id já na leitura). */
  const ctx = await requireModule("estoque");
  const cid = ctx.companyId;
  const { id } = await params;
  const original = await one<any>(`SELECT * FROM products WHERE id = ? AND company_id = ?`, [Number(id), cid]);
  if (!original) notFound();
  // Duplicar é escrita: quem só consulta nem abre o formulário (a action
  // também barra pelo papel, com PermissionError).
  if (!canEdit(ctx.role, "estoque")) redirect("/estoque?erro=permissao");

  const categories = await all<any>(`SELECT id, name FROM categories WHERE company_id = ? AND active = 1 ORDER BY name`, [cid]);
  const simpleProducts = await all<any>(
    `SELECT id, name, code, total_qty, rent_price_cents FROM products
      WHERE company_id = ? AND active = 1 AND kind <> 'kit' ORDER BY name`,
    [cid],
  );
  // A composição do kit é a definição comercial do produto — vai junto.
  const components =
    original.kind === "kit"
      ? await all<any>(
          `SELECT component_product_id AS product_id, quantity FROM product_components
            WHERE parent_product_id = ? AND company_id = ?`,
          [original.id, cid],
        )
      : [];
  const proximoCodigo = await nextProductCode();

  /* Modelo do formulário: só os campos copiáveis. Sem `id` (não é edição) e
     sem `code` (o código do duplicado é sempre novo). Estoque e manutenção
     começam em 0: o controle do novo produto é independente, e a quantidade
     fica livre para o operador informar antes de salvar. */
  const modelo = {
    code: "",
    name: `${original.name} (cópia)`,
    category_id: original.category_id,
    kind: original.kind,
    total_qty: 0,
    min_qty: original.min_qty,
    rent_price_cents: original.rent_price_cents,
    replace_cents: original.replace_cents,
    description: original.description,
    photo: original.photo,
    pricing_mode: original.pricing_mode,
  };

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <PageHeader
        title="Duplicar Produto"
        subtitle={`Modelo: ${original.name} (${original.code})`}
        action={<LinkButton href={`/estoque/${original.id}`}>Voltar ao produto</LinkButton>}
      />
      <Alerta tone="azul" title="Cadastro iniciado por duplicação">
        Os dados de <b>{original.name}</b> foram copiados como ponto de partida. Ajuste o que precisar e salve: um
        produto novo e independente será criado. O produto de origem não é alterado. Estoque e composição de unidades
        não são herdados — o estoque começa em 0 e vale a quantidade que você informar aqui.
      </Alerta>
      <Card>
        <ProductForm
          action={duplicateProduct}
          product={modelo}
          categories={categories}
          simpleProducts={simpleProducts}
          components={components}
          proximoCodigo={proximoCodigo}
          submitLabel="Criar produto duplicado"
          hiddenFields={{ source_id: original.id }}
        />
      </Card>
    </div>
  );
}
