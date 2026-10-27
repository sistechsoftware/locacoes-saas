import { requireModule } from "@/lib/auth";
import { bloquearRecurso, registrarNegacao, temRecurso } from "@/lib/plano-gate";
import LojaNav from "./LojaNav";

export const dynamic = "force-dynamic";

/**
 * Porta da seção: papel owner/admin (módulo configurações) + recurso
 * `loja_virtual` (plano Empresarial ou exceção administrativa). A revogação
 * derruba aqui, nas actions e na API pública — o menu some só por consequência.
 */
export default async function LojaLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireModule("configuracoes");
  if (!(await temRecurso(ctx.user, "loja_virtual"))) {
    registrarNegacao(ctx.companyId, "loja_virtual", "pagina-loja");
    bloquearRecurso("loja_virtual", ctx.user, "pagina");
  }
  return (
    <div className="space-y-4">
      <LojaNav />
      {children}
    </div>
  );
}
