import { requirePlatformAdmin } from "@/lib/auth";
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

  /*
   * Sem getSettings() aqui: o canto administrativo nao recebe NENHUM dado de
   * empresa. Antes o rodape da marca mostrava company_name do tenant (com
   * fallback "Lima's Locações"), o que misturava a identidade do cliente com a
   * do produto. O shell ja traz a assinatura Locô proprio.
   */
  return <SaasShell user={user}>{children}</SaasShell>;
}
