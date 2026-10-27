import { requireModule } from "@/lib/auth";
import { temRecurso, bloquearRecurso, registrarNegacao } from "@/lib/plano-gate";
import { produtosDaLoja } from "@/lib/loja-db";
import { Alerta, Badge, Empty, PageHeader, Section } from "@/components/ui";
import ImageInput from "@/components/ImageInput";
import { salvarProdutoAction } from "../actions";

export const dynamic = "force-dynamic";

const money = (cents: number) => `R$ ${(Number(cents || 0) / 100).toFixed(2).replace(".", ",")}`;

export default async function ProdutosLojaPage({ searchParams }: { searchParams: Promise<{ erro?: string; ok?: string }> }) {
  const ctx = await requireModule("configuracoes");
  if (!(await temRecurso(ctx.user, "loja_virtual"))) {
    registrarNegacao(ctx.companyId, "loja_virtual", "pagina-loja");
    bloquearRecurso("loja_virtual", ctx.user, "pagina");
  }
  const { erro, ok } = await searchParams;
  const produtos = await produtosDaLoja(ctx.companyId);
  const publicados = produtos.filter((p) => p.published === 1);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Produtos publicados"
        subtitle="Escolha quais itens do seu cadastro aparecem na loja. Nada é copiado: o catálogo lê os mesmos produtos, kits e preços do sistema."
        action={
            <Badge tone={publicados.length ? "verde" : "cinza"}>
            {publicados.length} de {produtos.length} publicados
          </Badge>
        }
      />
      {erro && <Alerta tone="vermelho">{erro}</Alerta>}
      {ok && <Alerta tone="verde">{ok}</Alerta>}

      {produtos.filter((p) => p.incompleto).length > 0 && (
        <Alerta tone="ambar" title="Produtos com dados incompletos">
          {produtos
            .filter((p) => p.incompleto)
            .slice(0, 6)
            .map((p) => `${p.name} (${p.incompleto})`)
            .join(" · ")}
          {produtos.filter((p) => p.incompleto).length > 6 ? " …" : ""} — corrija no cadastro antes de publicar.
        </Alerta>
      )}

      {produtos.length === 0 && <Empty>Nenhum produto cadastrado ainda. Cadastre em Estoque e volte aqui.</Empty>}

      <div className="grid gap-3 lg:grid-cols-2">
        {produtos.map((p) => (
          <Section
            key={p.product_id}
            title={`${p.name}${p.category ? ` · ${p.category}` : ""}`}
            action={
              <Badge tone={p.incompleto ? "ambar" : p.published ? "verde" : "cinza"}>
                {p.incompleto ? `incompleto: ${p.incompleto}` : p.published ? "publicado" : "oculto"}
              </Badge>
            }
          >
            <form action={salvarProdutoAction} className="space-y-3">
              <input type="hidden" name="product_id" value={p.product_id} />
              {p.photo && (
                <img
                  src={p.photo_url || p.photo}
                  alt={p.name}
                  className="h-24 w-24 rounded-lg border border-nuvem-200 bg-nuvem-50 object-cover"
                />
              )}
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="flex items-center gap-2 text-sm font-semibold">
                  <input type="checkbox" name="published" defaultChecked={p.published === 1} />
                  Publicar na loja
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" name="featured" defaultChecked={p.featured === 1} />
                  Destaque na página
                </label>
                <label className="text-sm">
                  <span className="rotulo">Preço da loja (vazio = preço do sistema: {money(p.rent_price_cents)})</span>
                  <input
                    name="public_price"
                    className="campo"
                    inputMode="decimal"
                    placeholder={p.public_price_cents == null ? "" : String((p.public_price_cents / 100).toFixed(2))}
                    defaultValue={p.public_price_cents == null ? "" : (p.public_price_cents / 100).toFixed(2).replace(".", ",")}
                  />
                </label>
                <label className="text-sm">
                  <span className="rotulo">Nome comercial (vazio = nome do cadastro)</span>
                  <input name="public_name" className="campo" defaultValue={p.public_name ?? ""} maxLength={120} />
                </label>
                <label className="text-sm">
                  <span className="rotulo">Ordem de exibição</span>
                  <input name="sort_order" type="number" min={0} max={9999} className="campo" defaultValue={p.sort_order} />
                </label>
                <label className="text-sm">
                  <span className="rotulo">Máx. por solicitação (vazio = estoque)</span>
                  <input name="max_qty" type="number" min={1} max={9999} className="campo" defaultValue={p.max_qty ?? ""} />
                </label>
              </div>
              <label className="block text-sm">
                <span className="rotulo">Descrição pública</span>
                <textarea
                  name="public_description"
                  className="campo"
                  rows={2}
                  maxLength={4000}
                  defaultValue={p.public_description ?? p.description ?? ""}
                />
              </label>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="text-sm">
                  <span className="rotulo">Foto principal da loja (opcional)</span>
                  <ImageInput name="photo_file" />
                </label>
                <div className="flex items-end justify-end">
                  <button type="submit" className="rounded-xl bg-marca-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-marca-700">
                    Salvar produto
                  </button>
                </div>
              </div>
            </form>
          </Section>
        ))}
      </div>
    </div>
  );
}
