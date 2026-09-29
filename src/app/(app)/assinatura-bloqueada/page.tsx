import { requireUser } from "@/lib/auth";
import { estadoAssinatura } from "@/lib/billing";
import GerarCobrancaButton from "../faturamento/GerarCobrancaButton";

export const dynamic = "force-dynamic";

function dataBR(iso: string | null) {
  return iso ? iso.slice(0, 10).split("-").reverse().join("/") : "—";
}

/**
 * Tela de bloqueio por assinatura (trial expirado, suspenso ou cancelado).
 *
 * O gate no layout manda TODA a área autenticada para cá — o usuário enxerga
 * apenas esta página até a assinatura voltar. O owner ainda pode gerar a
 * cobrança PIX daqui; os demais papéis veem a orientação de falar com ele.
 */
export default async function AssinaturaBloqueadaPage() {
  const user = await requireUser();
  const estado = await estadoAssinatura(user.company_id);

  return (
    <main className="flex min-h-screen items-center justify-center bg-gradient-to-b from-nuvem-200 to-nuvem-100 p-5">
      <div className="w-full max-w-md">
        <div className="cartao p-6 text-center shadow-sm">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-red-100 text-2xl">
            🔒
          </div>
          <h1 className="text-xl font-black text-tinta-900">Acesso temporariamente bloqueado</h1>
          <p className="mt-2 text-sm text-stone-600">
            {estado.status === "trial" && (
              <>O período de avaliação terminou em <b>{dataBR(estado.trial_ends_at)}</b>.</>
            )}
            {estado.status === "suspended" && <>A assinatura da empresa está suspensa por inadimplência.</>}
            {estado.status === "canceled" && <>A assinatura da empresa foi cancelada.</>}
          </p>
          {estado.plano && (
            <p className="mt-3 text-sm text-stone-500">
              Plano <b>{estado.plano.name}</b> ·{" "}
              {(estado.plano.price_cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}/mês
            </p>
          )}
          {user.role === "owner" ? (
            <div className="mt-4 text-left">
              <GerarCobrancaButton />
              <p className="mt-2 text-xs text-stone-500">
                Após o pagamento confirmado, o acesso volta automaticamente.
              </p>
            </div>
          ) : (
            <p className="mt-4 text-sm text-stone-500">
              Fale com o proprietário da conta para regularizar o pagamento.
            </p>
          )}
        </div>
      </div>
    </main>
  );
}
