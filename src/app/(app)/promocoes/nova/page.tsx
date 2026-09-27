import { assertAdmin } from "@/lib/auth";
import { sellableProducts } from "@/lib/stock";
import { PageHeader } from "@/components/ui";
import PromotionForm from "../PromotionForm";
import { createPromotion } from "../actions";

export const dynamic = "force-dynamic";

export default async function NovaPromocaoPage() {
  await assertAdmin();
  const produtos = await sellableProducts();
  return (
    <div className="space-y-4">
      <PageHeader title="Nova Promoção" subtitle="O preço da faixa vale para todas as unidades do item" />
      <PromotionForm action={createPromotion} produtos={produtos} submitLabel="Criar Promoção" />
    </div>
  );
}
