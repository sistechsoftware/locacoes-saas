import { requireCliente } from "@/lib/portal-auth";
import { configuracaoPortal } from "@/lib/portal";
import PortalNav from "../PortalNav";
import PortalSairButton from "../PortalSairButton";

export const dynamic = "force-dynamic";

/**
 * Area autenticada do portal. Toda pagina dentro deste grupo passa pelo
 * requireCliente(): sem sessao de cliente valida, nao ha dado nenhum.
 */
export default async function PortalAreaLayout({ children }: { children: React.ReactNode }) {
  const cliente = await requireCliente();
  const cfg = await configuracaoPortal();

  return (
    <div className="flex min-h-screen flex-col bg-nuvem-100">
      <header className="bg-gradient-to-r from-marca-700 to-marca-600 text-white">
        <div className="mx-auto flex w-full max-w-3xl items-center gap-3 px-4 py-3">
          {cfg.logo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={cfg.logo} alt="" className="h-9 w-9 rounded-xl object-contain" />
          ) : (
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-white/10 text-base font-black ring-1 ring-white/20">
              L
            </div>
          )}
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-bold leading-tight">{cfg.empresa}</p>
            <p className="truncate text-xs text-marca-100">Olá, {cliente.first_name}!</p>
          </div>
          <PortalSairButton />
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 px-4 pb-24 pt-4">{children}</main>

      <PortalNav />
    </div>
  );
}
