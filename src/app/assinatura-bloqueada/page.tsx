import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { estadoAssinaturaSeguro } from "@/lib/assinatura-gate";
import { lerConfig } from "@/lib/platform-settings";
import GerarCobrancaButton from "../(app)/faturamento/GerarCobrancaButton";

export const dynamic = "force-dynamic";

function dataBR(iso: string | null) {
  return iso ? iso.slice(0, 10).split("-").reverse().join("/") : "—";
}

/** Botão de sair da conta — funciona em QUALQUER estado (Etapa 9: a saída
 *  da conta não pode parar de funcionar por causa da suspensão). Form puro,
 *  sem dependência de JS, mesmo padrão do menu lateral. */
function SairDaConta() {
  return (
    <form action="/api/logout" method="post" className="mt-3">
      <button
        type="submit"
        className="w-full rounded-xl border border-nuvem-300 px-4 py-2.5 text-sm font-semibold text-tinta-700 transition hover:bg-nuvem-50"
      >
        Sair da conta
      </button>
    </form>
  );
}

/**
 * Canal de suporte exibido no bloqueio: o cliente que não consegue entrar é
 * justamente quem mais precisa de ajuda (cobrança/dúvida). Os valores vêm do
 * cadastro do painel /saas (platform_settings); sem cadastro, o bloco some.
 */
function ContatoSuporte({ email, whatsapp }: { email: string | null; whatsapp: string | null }) {
  if (!email && !whatsapp) return null;
  const msg = encodeURIComponent("Olá! Estou com a conta bloqueada no sistema Locô e preciso de ajuda.");
  return (
    <div className="mt-4 rounded-xl border border-sky-200 bg-sky-50 p-3 text-left text-sm text-sky-900">
      <p className="font-bold">Precisa de ajuda? O suporte continua disponível.</p>
      <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1">
        {email && (
          <a className="font-semibold underline" href={`mailto:${email}`}>
            {email}
          </a>
        )}
        {whatsapp && (
          <a
            className="font-semibold underline"
            href={`https://wa.me/${whatsapp.replace(/\D/g, "")}?text=${msg}`}
            target="_blank"
            rel="noreferrer"
          >
            Falar no WhatsApp
          </a>
        )}
      </div>
      <p className="mt-1 text-xs text-sky-700">Atendimento para dúvidas de cobrança e acesso — mesmo com a conta bloqueada.</p>
    </div>
  );
}

/**
 * Tela de bloqueio por assinatura (trial expirado, suspenso ou cancelado).
 *
 * FORA do grupo (app) DE PROPÓSITO — correção do loop infinito de suspensão:
 * o layout (app) redireciona TODA a área autenticada para ESTA URL quando a
 * assinatura está bloqueada. Enquanto a página vivia dentro do grupo, o
 * MESMO layout a envolveria e voltaria a redirecionar para ela mesma em
 * ciclo infinito (NEXT_REDIRECT sobre a própria rota): o usuário nunca via
 * esta tela e o navegador ficava girando em atualizações. A URL continua
 * /assinatura-bloqueada — só a pasta mudou. A posição é travada por teste
 * estático em tests/assinatura-gate.test.ts.
 *
 * O gate no layout manda TODA a área autenticada para cá — o usuário enxerga
 * apenas esta página até a assinatura voltar. O owner ainda pode gerar a
 * cobrança daqui (Pix, cartão ou boleto); os demais papéis veem a orientação
 * de falar com ele. Todos podem sair da conta.
 */
export default async function AssinaturaBloqueadaPage() {
  // Esta tela É o bloqueio: é o segundo (e último) ponto autorizado a ignorar
  // o gate — sem isso o usuário ficaria preso num erro em vez de vê-la.
  const user = await requireUser({ bloqueio: "ignorar" });
  const [estado, suporteEmail, suporteWhats] = await Promise.all([
    estadoAssinaturaSeguro(user.company_id),
    lerConfig("suporte_email"),
    lerConfig("suporte_whatsapp"),
  ]);

  // Visita direta com assinatura em ordem (trial vigente, ativa ou em
  // tolerância): isto não é tela de bloqueio — devolve para o sistema em vez
  // de exibir um aviso que não corresponde ao estado real.
  if (estado && !estado.bloqueioDuro) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-gradient-to-b from-nuvem-200 to-nuvem-100 p-5">
        <div className="w-full max-w-md">
          <div className="cartao p-6 text-center shadow-sm">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-100 text-2xl">
              ✓
            </div>
            <h1 className="text-xl font-black text-tinta-900">Sua assinatura está ativa</h1>
            <p className="mt-2 text-sm text-stone-600">
              Não há bloqueio na conta. Se você foi direcionado para cá por engano, volte ao sistema.
            </p>
            <Link
              href="/dashboard"
              className="mt-4 inline-block rounded-xl bg-marca-600 px-4 py-2.5 text-sm font-bold text-white transition hover:bg-marca-700"
            >
              Ir para o sistema
            </Link>
            <SairDaConta />
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-gradient-to-b from-nuvem-200 to-nuvem-100 p-5">
      <div className="w-full max-w-md">
        <div className="cartao p-6 text-center shadow-sm">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-red-100 text-2xl">
            🔒
          </div>
          <h1 className="text-xl font-black text-tinta-900">Acesso temporariamente bloqueado</h1>
          <p className="mt-2 text-sm text-stone-600">
            {!estado && (
              <>
                Não foi possível confirmar a assinatura agora. <b>Tente novamente em instantes.</b>
              </>
            )}
            {estado?.status === "trial" && (
              <>O período de avaliação terminou em <b>{dataBR(estado.trial_ends_at)}</b>.</>
            )}
            {estado?.status === "suspended" && (
              <>A assinatura da empresa está suspensa. O acesso é restabelecido quando a suspensão for encerrada.</>
            )}
            {estado?.status === "canceled" && <>A assinatura da empresa foi cancelada.</>}
          </p>
          {estado?.plano && (
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
          <ContatoSuporte email={suporteEmail} whatsapp={suporteWhats} />
          <SairDaConta />
        </div>
      </div>
    </main>
  );
}
