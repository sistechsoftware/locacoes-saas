import { redirect } from "next/navigation";
import Link from "next/link";
import { currentUser } from "@/lib/auth";
import { planoPorSlug } from "@/lib/billing";
import { DIAS_TRIAL_PADRAO } from "@/lib/onboarding";
import AssinarForm from "./AssinarForm";

export const dynamic = "force-dynamic";

/**
 * Checkout público (Etapa 4 do SaaS): cadastro de uma NOVA empresa com trial.
 *
 * Fora do grupo (app): rota aberta, sem sessão. Quem já tem sessão é mandado
 * direto para o sistema. O plano vem da query (?plano=slug) e é revalidado no
 * servidor contra o catálogo — o formulário nunca é fonte de autoridade.
 */
export default async function AssinarPage({
  searchParams,
}: {
  searchParams: Promise<{ plano?: string }>;
}) {
  if (await currentUser()) redirect("/dashboard");

  const slug = (await searchParams).plano ?? "";
  const plano = await planoPorSlug(slug);
  if (!plano) redirect("/planos");

  return (
    <main className="flex min-h-screen items-center justify-center bg-gradient-to-b from-nuvem-200 to-nuvem-100 p-5">
      <div className="w-full max-w-md">
        <div className="mb-6 text-center">
          <Link
            href="/planos"
            className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-marca-600 text-2xl font-black text-white shadow-lg"
          >
            L
          </Link>
          <h1 className="text-2xl font-black tracking-tight text-tinta-900">Crie sua conta</h1>
          <p className="text-sm text-stone-500">
            Plano <b>{plano.name}</b> ·{" "}
            {(plano.price_cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" })
              .replace("R$", "R$ ")
              .replace(/\s+/g, " ")
              .trim()}
            /mês · <b>{plano.trial_days || DIAS_TRIAL_PADRAO} dias grátis</b>
          </p>
        </div>

        <div className="cartao p-5 shadow-sm">
          <AssinarForm planoInicial={plano.slug} />
        </div>

        <p className="mt-5 text-center text-xs text-stone-500">
          Já tem conta?{" "}
          <a href="/login" className="font-semibold text-marca-600 underline">
            Entrar
          </a>
        </p>
      </div>
    </main>
  );
}
