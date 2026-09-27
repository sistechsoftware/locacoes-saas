import Link from "next/link";
import { redirect } from "next/navigation";
import { clienteAtual } from "@/lib/portal-auth";
import { getSettings } from "@/lib/settings";
import PortalLoginForm from "./PortalLoginForm";

export const dynamic = "force-dynamic";

/**
 * Entrada do Portal do Cliente, independente do login interno (usuarios da
 * equipe entram por /login; clientes entram por /portal/login).
 */
export default async function PortalLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ feito?: string }>;
}) {
  if (await clienteAtual()) redirect("/portal");
  const { feito } = await searchParams;
  const s = await getSettings();

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-gradient-to-b from-marca-800 via-marca-700 to-marca-600 p-5">
      <div className="mb-6 text-center">
        {s.company_logo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={s.company_logo} alt="Logo" className="mx-auto mb-3 h-20 w-20 rounded-2xl object-contain shadow-lg" />
        ) : (
          <div className="mx-auto mb-3 flex h-20 w-20 items-center justify-center rounded-2xl bg-white/10 text-3xl font-black text-white shadow-lg ring-1 ring-white/20">
            L
          </div>
        )}
        <h1 className="text-2xl font-black tracking-tight text-white">{s.company_name}</h1>
        <p className="mt-0.5 text-sm text-marca-100">Portal do Cliente · Acompanhe suas locações e recompensas</p>
      </div>

      <div className="w-full max-w-sm">
        {feito === "1" && (
          <div className="mb-3 rounded-xl border border-emerald-300 bg-emerald-50 px-3 py-2.5 text-sm font-medium text-emerald-800">
            🎉 Acesso criado! Entre com seu CPF e a senha que você definiu.
          </div>
        )}

        <div className="cartao p-5 shadow-xl">
          <PortalLoginForm />
          <p className="mt-4 border-t border-nuvem-200 pt-3 text-center text-xs text-stone-500">
            Primeiro acesso?{" "}
            <Link href="/portal/primeiro-acesso" className="font-semibold text-marca-600">
              Criar meu acesso
            </Link>
          </p>
        </div>

        <p className="mt-5 text-center text-xs leading-relaxed text-marca-100/80">
          Área exclusiva para clientes. Equipe Lima&apos;s,{" "}
          <Link href="/login" className="underline">
            entre aqui
          </Link>
          .
        </p>
      </div>
    </main>
  );
}
