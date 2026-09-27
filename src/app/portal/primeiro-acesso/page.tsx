import Link from "next/link";
import { getSettings } from "@/lib/settings";
import PortalSetupForm from "./PortalSetupForm";

export const dynamic = "force-dynamic";

/**
 * Primeiro acesso ao portal (ou redefinicao de senha).
 *
 * A equipe gera o convite no cadastro do cliente e manda o link pelo WhatsApp:
 * /portal/primeiro-acesso?token=... Aqui o cliente confirma CPF e telefone
 * cadastrados — o token sozinho nao basta — e define a senha.
 */
export default async function PrimeiroAcessoPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  const s = await getSettings();
  const temToken = !!token && token.length >= 16 && token.length <= 128;

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-gradient-to-b from-marca-800 via-marca-700 to-marca-600 p-5">
      <div className="mb-6 text-center">
        {s.company_logo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={s.company_logo} alt="Logo" className="mx-auto mb-3 h-16 w-16 rounded-2xl object-contain shadow-lg" />
        ) : (
          <div className="mx-auto mb-3 flex h-16 w-16 items-center justify-center rounded-2xl bg-white/10 text-2xl font-black text-white shadow-lg ring-1 ring-white/20">
            L
          </div>
        )}
        <h1 className="text-xl font-black tracking-tight text-white">Criar meu acesso</h1>
        <p className="mt-0.5 text-sm text-marca-100">Portal do Cliente {s.company_name}</p>
      </div>

      <div className="w-full max-w-sm">
        {!temToken ? (
          <div className="cartao p-5 text-center">
            <p className="text-3xl">🔗</p>
            <p className="mt-2 text-sm font-semibold text-tinta-900">Link de acesso inválido</p>
            <p className="mt-1 text-sm text-stone-500">
              Este link está incompleto. Peça um novo link de acesso à Lima&apos;s pelo WhatsApp.
            </p>
          </div>
        ) : (
          <div className="cartao p-5 shadow-xl">
            <PortalSetupForm token={token!} />
          </div>
        )}

        <p className="mt-5 text-center text-xs text-marca-100/80">
          Já tem acesso?{" "}
          <Link href="/portal/login" className="font-semibold text-white underline">
            Entrar no portal
          </Link>
        </p>
      </div>
    </main>
  );
}
