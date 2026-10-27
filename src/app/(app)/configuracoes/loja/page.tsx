import Link from "next/link";
import { headers } from "next/headers";
import { requireModule } from "@/lib/auth";
import { temRecurso, bloquearRecurso, registrarNegacao } from "@/lib/plano-gate";
import { checklistLoja, lojaDaEmpresa, resumoLoja } from "@/lib/loja-db";
import { origemDaRequisicao } from "@/lib/portal-core";
import { Alerta, Badge, Empty, PageHeader, Section, Stat, LinkButton, BTN } from "@/components/ui";
import CopiarLink from "./CopiarLink";
import { publicarAcao } from "./actions";

export const dynamic = "force-dynamic";

const ROTULO_STATUS: Record<string, { label: string; tone: "verde" | "ambar" | "cinza" }> = {
  publicada: { label: "Publicada", tone: "verde" },
  rascunho: { label: "Rascunho (não publicada)", tone: "ambar" },
  desativada: { label: "Desativada", tone: "cinza" },
};

export default async function LojaVisaoGeral({ searchParams }: { searchParams: Promise<{ erro?: string; ok?: string }> }) {
  const ctx = await requireModule("configuracoes");
  if (!(await temRecurso(ctx.user, "loja_virtual"))) {
    registrarNegacao(ctx.companyId, "loja_virtual", "pagina-loja");
    bloquearRecurso("loja_virtual", ctx.user, "pagina");
  }
  const { erro, ok } = await searchParams;
  const [loja, resumo, checklist, origem] = await Promise.all([
    lojaDaEmpresa(ctx.companyId),
    resumoLoja(ctx.companyId),
    checklistLoja(ctx.companyId),
    origemDaRequisicao(await headers()),
  ]);
  const link = loja ? `${origem}/loja/${loja.slug}` : null;
  const status = loja?.paused ? { label: "Pausada", tone: "ambar" as const } : ROTULO_STATUS[loja?.status ?? "desativada"];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Minha Loja Virtual"
        subtitle="Catálogo público, pedidos e orçamentos integrados à sua operação."
        action={
          link ? (
            <>
              <CopiarLink href={link} />
              <a href={link} target="_blank" rel="noopener noreferrer" className={BTN.secundario}>
                Abrir minha loja
              </a>
            </>
          ) : undefined
        }
      />

      {erro && <Alerta tone="vermelho">{erro}</Alerta>}
      {ok && <Alerta tone="verde">{ok}</Alerta>}

      <Section title="Estado da loja">
        {!loja ? (
          <Empty>
            Esta empresa ainda não configurou uma loja.{" "}
            <Link href="/configuracoes/loja/publicacao" className="font-semibold text-marca-600 underline">
              Começar em Publicação
            </Link>
            .
          </Empty>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={status.tone}>{status.label}</Badge>
              {loja.published_at && <span className="text-xs text-stone-500">Primeira publicação em {loja.published_at}</span>}
            </div>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <input readOnly value={link ?? ""} className="campo flex-1 font-mono text-xs" />
            </div>
            <p className="text-xs text-stone-500">
              Compartilhe este link no WhatsApp, Instagram e Google. Ele continua o mesmo depois de qualquer alteração de configuração.
            </p>

            <form action={publicarAcao} className="flex flex-wrap gap-2">
              {loja.status === "publicada" ? (
                <>
                  <input type="hidden" name="acao" value="desativar" />
                  <button className={BTN.perigo} type="submit">
                    Tirar do ar
                  </button>
                </>
              ) : (
                <>
                  <input type="hidden" name="acao" value="publicar" />
                  <button className={BTN.primario} type="submit">
                    Publicar loja
                  </button>
                </>
              )}
            </form>
            {loja.status === "publicada" && (
              <form action={publicarAcao} className="flex flex-wrap gap-2">
                <input type="hidden" name="acao" value={loja.paused ? "retomar" : "pausar"} />
                <button className={BTN.secundario} type="submit">
                  {loja.paused ? "Retomar recebimento" : "Pausar temporariamente"}
                </button>
                <span className="self-center text-xs text-stone-500">
                  Pausar mantém a página no ar, mas não aceita novos pedidos.
                </span>
              </form>
            )}
          </div>
        )}
      </Section>

      <Section title="Checklist de publicação">
        <div className="space-y-1.5">
          {checklist.itens.map((i) => (
            <div key={i.chave} className="flex items-start gap-2 text-sm">
              <span aria-hidden>{i.ok ? "✅" : "⚠️"}</span>
              <span className={i.ok ? "text-stone-600" : "font-semibold text-tinta-900"}>
                {i.label}
                {!i.ok && i.detalhe ? <span className="block text-xs font-normal text-stone-500">{i.detalhe}</span> : null}
              </span>
            </div>
          ))}
        </div>
        {!checklist.ok && (
          <p className="mt-3 text-xs text-stone-500">Complete os itens acima antes de publicar pela primeira vez.</p>
        )}
      </Section>

      <Section title="Solicitações recebidas">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <Stat label="Total" value={resumo.total} href="/configuracoes/loja/pedidos" />
          <Stat label="Aguardando análise" value={resumo.aguardando} href="/configuracoes/loja/pedidos?filtro=pendentes" tone={resumo.aguardando ? "vermelho" : undefined} />
          <Stat label="Orçamentos abertos" value={resumo.orcamentos} href="/configuracoes/loja/pedidos" />
          <Stat label="Aguardando pagamento" value={resumo.aguardandoPagamento} href="/configuracoes/loja/pedidos?filtro=pendentes" />
          <Stat label="Comprovantes a verificar" value={resumo.comprovantes} href="/configuracoes/loja/pedidos?filtro=comprovantes" tone={resumo.comprovantes ? "vermelho" : undefined} />
        </div>
        {resumo.total === 0 && (
          <p className="mt-3 text-xs text-stone-500">
            Os números vêm do banco: nenhum pedido recebido ainda. Assim que um cliente enviar uma solicitação, ela aparece aqui e
            nas notificações da equipe.
          </p>
        )}
      </Section>
    </div>
  );
}
