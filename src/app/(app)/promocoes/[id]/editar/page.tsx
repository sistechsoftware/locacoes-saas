import { notFound } from "next/navigation";
import { assertAdmin } from "@/lib/auth";
import { sellableProducts } from "@/lib/stock";
import { getPromocao } from "@/lib/promocoes-db";
import { PageHeader } from "@/components/ui";
import PromotionForm from "../../PromotionForm";
import { updatePromotion } from "../../actions";

export const dynamic = "force-dynamic";

export default async function EditarPromocaoPage({ params }: { params: Promise<{ id: string }> }) {
  await assertAdmin();
  const { id } = await params;
  const [promocao, produtos] = await Promise.all([getPromocao(Number(id)), sellableProducts()]);
  if (!promocao) notFound();
  return (
    <div className="space-y-4">
      <PageHeader title="Editar Promoção" subtitle={promocao.product_name} />
      <PromotionForm action={updatePromotion} produtos={produtos} promocao={promocao} />
    </div>
  );
}
