import { headers } from "next/headers";
import { requireModule } from "@/lib/auth";
import { temRecurso, bloquearRecurso, registrarNegacao } from "@/lib/plano-gate";
import { checklistLoja, lojaDaEmpresa } from "@/lib/loja-db";
import { origemDaRequisicao } from "@/lib/portal-core";
import { Alerta, Badge, Field, PageHeader, Section, BTN } from "@/components/ui";
import CopiarLink from "../CopiarLink";
import { publicarAcao, salvarSlugAction } from "../actions";

export const dynamic = "force-dynamic";

export default async function PublicacaoLojaPage({ searchParams }: { searchParams: Promise<{ erro?: string; ok?: string }> }) {
  const ctx = await requireModule("configuracoes");
  if (!(await temRecurso(ctx.user, "loja_virtual"))) {
    registrarNegacao(ctx.companyId, "loja_virtual", "pagina-loja");
    bloquearRecurso("loja_virtual", ctx.user, "pagina");
  }
  const { erro, ok } = await searchParams;
  const [loja, checklist, origem] = await Promise.all([
    lojaDaEmpresa(ctx.companyId),
    checklistLoja(ctx.companyId),
    origemDaRequisicao(await headers()),
  ]);
  const link = loja ? `${origem}/loja/${loja.slug}` : null;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Publicação e compartilhamento"
        subtitle="Endereço único da sua loja, estado de publicação e o link para os clientes."
      />
      {erro && <Alerta tone="vermelho">{erro}</Alerta>}
      {ok && <Alerta tone="verde">{ok}</Alerta>}

      <Section title="Endereço público">
        <form action={salvarSlugAction} className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="flex-1">
            <Field
              label="Identificador da loja"
              hint="Somente letras minúsculas, números e hífens. Deve ser único e não pode ser uma rota reservada do sistema."
            >
              <div className="flex items-center gap-1">
                <span className="text-sm text-stone-500">/loja/</span>
                <input name="slug" className="campo font-mono" defaultValue={loja?.slug ?? ""} maxLength={40} required pattern="[a-z0-9-]+" />
              </div>
            </Field>
          </div>
          <button type="submit" className={BTN.secundario}>
            Salvar endereço
          </button>
        </form>
        {link && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <input readOnly value={link} className="campo flex-1 font-mono text-xs" />
            <CopiarLink href={link} />
            <a href={link} target="_blank" rel="noopener noreferrer" className={BTN.secundario}>
              Abrir loja
            </a>
            <a href={`${origem}/loja/${loja!.slug}?previa=1`} target="_blank" rel="noopener noreferrer" className={BTN.secundario}>
              Pré-visualizar
            </a>
          </div>
        )}
      </Section>

      <Section title="Checklist essencial">
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
      </Section>

      <Section title="Estado">
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={loja?.status === "publicada" ? "verde" : "cinza"}>
              {loja?.status === "publicada" ? "No ar" : "Fora do ar"}
            </Badge>
            {loja?.paused === 1 && <Badge tone="ambar">Pausada (não recebe pedidos)</Badge>}
            {loja?.published_at && <span className="text-xs text-stone-500">publicada desde {loja.published_at}</span>}
          </div>
          <div className="flex flex-wrap gap-2">
            <form action={publicarAcao}>
              <input type="hidden" name="acao" value={loja?.status === "publicada" ? "desativar" : "publicar"} />
              <button type="submit" className={loja?.status === "publicada" ? BTN.perigo : BTN.primario}>
                {loja?.status === "publicada" ? "Tirar do ar" : "Publicar agora"}
              </button>
            </form>
            {loja?.status === "publicada" && (
              <form action={publicarAcao} className="flex items-center gap-2">
                <input type="hidden" name="acao" value={loja.paused ? "retomar" : "pausar"} />
                <button type="submit" className={BTN.secundario}>
                  {loja.paused ? "Retomar pedidos" : "Pausar pedidos"}
                </button>
              </form>
            )}
          </div>
          <p className="text-xs text-stone-500">
            Tirar do ar ou pausar nunca apaga produtos, configurações ou histórico de pedidos — apenas novas solicitações públicas
            são bloqueadas. O acompanhamento de pedidos já enviados continua funcionando.
          </p>
        </div>
      </Section>
    </div>
  );
}
