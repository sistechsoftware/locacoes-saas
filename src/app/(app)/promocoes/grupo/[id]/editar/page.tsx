import { notFound } from "next/navigation";
import { assertAdmin, requireModule } from "@/lib/auth";
import { sellableProducts } from "@/lib/stock";
import { getGrupo } from "@/lib/promocoes-db";
import { PageHeader } from "@/components/ui";
import PromotionForm from "../../../PromotionForm";
import { updateGroupPromotion } from "../../../actions";

export const dynamic = "force-dynamic";

export default async function EditarPromocaoGrupoPage({ params }: { params: Promise<{ id: string }> }) {
  await requireModule("promocoes");
  await assertAdmin();
  const { id } = await params;
  const [grupo, produtos] = await Promise.all([getGrupo(Number(id)), sellableProducts()]);
  if (!grupo) notFound();
  return (
    <div className="space-y-4">
      <PageHeader
        title="Editar Promoção em Grupo"
        subtitle={`${grupo.promotions.length} produto(s) · a regra vale para todos os selecionados`}
      />
      <PromotionForm action={updateGroupPromotion} produtos={produtos} grupo={grupo} />
    </div>
  );
}
