import { requirePlatformAdmin } from "@/lib/auth";
import { getSettings } from "@/lib/settings";
import { SaasShell } from "@/components/SaasShell";

export const dynamic = "force-dynamic";

/**
 * Ambiente administrativo da PLATAFORMA — separado do app operacional.
 *
 * Fronteira server-side: qualquer request dentro de /saas passa por aqui e
 * quem não for platform_admin é REDIRECIONADO para o dashboard operacional
 * (nunca 404 que revele a rota; nunca conteúdo). Layout, menu e consultas
 * são próprios — nada do app do locador é reaproveitado aqui.
 */
export default async function SaasLayout({ children }: { children: React.ReactNode }) {
  const user = await requirePlatformAdmin();
  const settings = await getSettings();

  return (
    <SaasShell user={user} plataforma={settings.company_name ?? "Lima's Locações"}>
      {children}
    </SaasShell>
  );
}
