import { notFound, redirect } from "next/navigation";
import { assertAdmin, requireModule } from "@/lib/auth";
import { sellableProducts } from "@/lib/stock";
import { getPromocao } from "@/lib/promocoes-db";
import { PageHeader } from "@/components/ui";
import PromotionForm from "../../PromotionForm";
import { updatePromotion } from "../../actions";

export const dynamic = "force-dynamic";

export default async function EditarPromocaoPage({ params }: { params: Promise<{ id: string }> }) {
  await requireModule("promocoes");
  await assertAdmin();
  const { id } = await params;
  const [promocao, produtos] = await Promise.all([getPromocao(Number(id)), sellableProducts()]);
  if (!promocao) notFound();
  // Editar um membro sozinho deixaria o grupo inconsistente.
  if (promocao.group_id) redirect(`/promocoes/grupo/${promocao.group_id}/editar`);
  return (
    <div className="space-y-4">
      <PageHeader title="Editar Promoção" subtitle={promocao.product_name} />
      <PromotionForm action={updatePromotion} produtos={produtos} promocao={promocao} />
    </div>
  );
}
