import { notFound } from "next/navigation";
import { requirePlatformAdmin } from "@/lib/auth";
import { all, one } from "@/lib/db";
import { assinaturaDaEmpresa, estadoAssinatura, STATUS_ROTULO, type SubscriptionStatus } from "@/lib/billing";
import {
  NOME_DA_CATEGORIA,
  NOME_DO_PLANO,
  RECURSOS,
  ehPlanoValido,
  type CategoriaRecurso,
  type OrigemPermissao,
} from "@/lib/planos";
import { estadoRecursosEmpresa, listarCortesias } from "@/lib/plano-personalizado";
import { utcParaLocal } from "@/lib/format";
import { Badge, Card, Empty, Section } from "@/components/ui";
import RecursosEmpresa from "./RecursosEmpresa";
import CortesiasEmpresa from "./CortesiasEmpresa";

export const dynamic = "force-dynamic";

function money(centavos: number | null | undefined) {
  if (centavos === null || centavos === undefined) return "—";
  return (centavos / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function dataBR(iso: string | null | undefined) {
  return iso ? iso.slice(0, 10).split("-").reverse().join("/") : "—";
}

const TONE_STATUS: Record<SubscriptionStatus | "sem", any> = {
  trial: "ambar",
  active: "verde",
  past_due: "terracota",
  suspended: "vermelho",
  canceled: "cinza",
  sem: "cinza",
};

const TONE_ORIGEM: Record<OrigemPermissao, any> = {
  fundamental: "azul",
  plano: "verde",
  liberacao_admin: "roxo",
  cortesia: "ambar",
  bloqueio_admin: "vermelho",
  nao_incluido: "cinza",
};

const ROTULO_ORIGEM: Record<OrigemPermissao, string> = {
  fundamental: "Base do sistema",
  plano: "Incluída no plano",
  liberacao_admin: "Liberação excepcional",
  cortesia: "Cortesia vigente",
  bloqueio_admin: "Bloqueada excepcionalmente",
  nao_incluido: "Fora do plano",
};

type LogLinha = {
  id: number;
  user_name: string | null;
  action: string;
  summary: string;
  meta: string | null;
  created_at: string;
};

/**
 * Detalhes comerciais de UMA empresa cliente — a área de gestão avançada de
 * planos do painel /saas (só platform_admin, guard no layout E nesta página).
 *
 * Seções: A) plano e assinatura; B) funcionalidades e permissões efetivas;
 * C) cortesias; D) histórico administrativo. Nada aqui altera assinatura,
 * preço ou cobrança — personalização é camada por cima, auditada.
 */
export default async function SaasEmpresaDetalhePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requirePlatformAdmin();
  const { id } = await params;
  const companyId = Number(id);
  if (!Number.isInteger(companyId) || companyId <= 0) notFound();

  const empresa = await one<{ id: number; name: string; active: number; email: string | null }>(
    `SELECT id, name, active, email FROM companies WHERE id = ?`,
    [companyId],
  );
  if (!empresa) notFound();

  const [estado, recursos, cortesias] = await Promise.all([
    estadoAssinatura(companyId),
    estadoRecursosEmpresa(companyId),
    listarCortesias(companyId),
  ]);
  const assinatura = await assinaturaDaEmpresa(companyId);
  const dono = await one<{ name: string; email: string | null }>(
    `SELECT name, email FROM users WHERE company_id = ? AND role = 'owner' AND active = 1 ORDER BY id LIMIT 1`,
    [companyId],
  );
  const usuariosAtivos = await one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM users WHERE company_id = ? AND active = 1`,
    [companyId],
  );
  const limiteAjuste = await one<{ max_users: number; reason: string | null; created_by_name: string | null }>(
    `SELECT max_users, reason, created_by_name FROM company_limit_overrides WHERE company_id = ?`,
    [companyId],
  );

  const planoAtual = estado.plano?.name ?? (recursos.plano ? NOME_DO_PLANO[recursos.plano] : "não identificado");
  const cortesiaAtiva = cortesias.find((c) => c.estado === "ativa");

  // Histórico: ações da plataforma sobre ESTA empresa (entity_id = company_id
  // nos registros gravados pelas actions do painel).
  const historico = await all<LogLinha>(
    `SELECT id, user_name, action, summary, meta, created_at
       FROM audit_logs
      WHERE entity = 'company' AND entity_id = ?
      ORDER BY id DESC LIMIT 60`,
    [companyId],
  );
  // Inclui também as trocas de plano (entidade subscription, mesmo alvo).
  const historicoPlano = await all<LogLinha>(
    `SELECT id, user_name, action, summary, meta, created_at
       FROM audit_logs
      WHERE entity = 'subscription' AND entity_id = ? AND action LIKE 'plataforma.%'
      ORDER BY id DESC LIMIT 30`,
    [companyId],
  );
  const linhaDoTempo = [...historico, ...historicoPlano].sort((a, b) => b.id - a.id).slice(0, 60);

  // Recursos agrupados por categoria, com a situação efetiva exibida.
  const categorias: CategoriaRecurso[] = ["operacao", "relacionamento", "gestao"];
  const porCategoria = categorias.map((cat) => ({
    categoria: cat,
    itens: recursos.recursos.filter((r) => RECURSOS[r.recurso].categoria === cat),
  }));

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-black tracking-tight text-tinta-900">
            #{empresa.id} · {empresa.name} {!empresa.active && <span className="text-xs font-normal text-stone-400">(inativa)</span>}
          </h1>
          <p className="text-sm text-stone-500">
            {dono ? <>Responsável: {dono.name}{dono.email ? ` · ${dono.email}` : ""}</> : "Sem proprietário ativo"}
            {empresa.email ? ` · ${empresa.email}` : ""}
          </p>
        </div>
        <Badge tone={TONE_STATUS[estado.status ?? "sem"]}>
          {estado.status ? STATUS_ROTULO[estado.status] : "sem assinatura"}
        </Badge>
      </div>

      {/* -------------------------------------------------------------- A */}
      <Section title="A. Plano e assinatura">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Card className="!p-3">
            <p className="text-xs uppercase tracking-wide text-stone-500">Plano comercial contratado</p>
            <p className="mt-1 text-lg font-bold text-tinta-900">{planoAtual}</p>
            <p className="text-xs text-stone-500">{money(estado.plano?.price_cents ?? null)}/mês · ciclo mensal</p>
          </Card>
          <Card className="!p-3">
            <p className="text-xs uppercase tracking-wide text-stone-500">Situação</p>
            <p className="mt-1 text-lg font-bold text-tinta-900">{estado.rotulo}</p>
            <p className="text-xs text-stone-500">
              {estado.status === "trial" && <>trial até {dataBR(estado.trial_ends_at)}</>}
              {(estado.status === "active" || estado.status === "past_due") && <>período até {dataBR(estado.current_period_end)}</>}
              {(estado.status === "suspended" || estado.status === "canceled") && <>acesso bloqueado</>}
              {!estado.status && <>sem assinatura registrada</>}
            </p>
          </Card>
          <Card className="!p-3">
            <p className="text-xs uppercase tracking-wide text-stone-500">Usuários ativos</p>
            <p className="mt-1 text-lg font-bold text-tinta-900">
              {usuariosAtivos?.n ?? 0}
              <span className="ml-1 text-sm font-semibold text-stone-500">
                / {limiteAjuste?.max_users ?? estado.plano?.max_users ?? 3}
              </span>
            </p>
            <p className="text-xs text-stone-500">
              {limiteAjuste
                ? <>limite ajustado{limiteAjuste.reason ? ` — ${limiteAjuste.reason}` : ""}</>
                : "limite do plano"}
            </p>
          </Card>
        </div>
        {assinatura && (
          <p className="mt-3 text-xs text-stone-500">
            Assinatura #{assinatura.id} · início do período {dataBR(assinatura.current_period_start)} ·
            vencimento {dataBR(assinatura.current_period_end)}
            {assinatura.payment_method ? ` · ${assinatura.payment_method}` : ""}
            {" "}· preço e cobranças não são afetados por personalizações desta tela.
          </p>
        )}
      </Section>

      {/* -------------------------------------------------------------- B */}
      <Section title="B. Funcionalidades e permissões">
        {cortesiaAtiva && (
          <p className="mb-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800">
            Cortesia ativa: plano {NOME_DO_PLANO[cortesiaAtiva.plan_slug as keyof typeof NOME_DO_PLANO] ?? cortesiaAtiva.plan_slug} até{" "}
            {cortesiaAtiva.ends_at.replace("T", " ")} — ao expirar, os acessos voltam às condições comerciais vigentes.
          </p>
        )}
        <div className="space-y-4">
          {porCategoria.map((grupo) => (
            <div key={grupo.categoria}>
              <h3 className="mb-2 text-xs font-bold uppercase tracking-wide text-stone-500">
                {NOME_DA_CATEGORIA[grupo.categoria]}
              </h3>
              <div className="divide-y divide-nuvem-100 rounded-xl border border-nuvem-200">
                {grupo.itens.map((r) => {
                  const def = RECURSOS[r.recurso];
                  return (
                    <div key={r.recurso} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5">
                      <div className="min-w-48 flex-1">
                        <p className="text-sm font-semibold text-tinta-900">
                          {def.nome}
                          {def.fundamental && <span className="ml-1.5 text-[0.65rem] font-normal text-stone-400">base</span>}
                        </p>
                        <p className="text-xs text-stone-500">{def.descricao}</p>
                      </div>
                      <Badge tone={TONE_ORIGEM[r.origem]}>{ROTULO_ORIGEM[r.origem]}</Badge>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
        <div className="mt-4">
          <RecursosEmpresa
            companyId={empresa.id}
            recursos={recursos.recursos.map((r) => ({
              recurso: r.recurso,
              origem: r.origem,
              liberado: r.liberado,
            }))}
            limiteAtual={limiteAjuste?.max_users ?? estado.plano?.max_users ?? 3}
            limiteAjustado={limiteAjuste?.max_users ?? null}
          />
        </div>
      </Section>

      {/* -------------------------------------------------------------- C */}
      <Section title="C. Cortesias">
        <CortesiasEmpresa
          companyId={empresa.id}
          cortesias={cortesias.map((c) => ({
            id: c.id,
            plan_slug: c.plan_slug,
            starts_at: c.starts_at,
            ends_at: c.ends_at,
            reason: c.reason,
            estado: c.estado,
            created_by_name: c.created_by_name,
            canceled_at: c.canceled_at,
          }))}
        />
      </Section>

      {/* -------------------------------------------------------------- D */}
      <Section title="D. Histórico administrativo">
        {linhaDoTempo.length === 0 ? (
          <Empty>Nenhuma alteração administrativa registrada.</Empty>
        ) : (
          <ol className="divide-y divide-nuvem-100">
            {linhaDoTempo.map((l) => (
              <li key={l.id} className="flex flex-wrap items-start justify-between gap-2 py-2">
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-tinta-900">{l.summary}</p>
                  <p className="text-xs text-stone-500">
                    {l.action}
                    {l.meta ? ` · ${l.meta.slice(0, 220)}` : ""}
                  </p>
                </div>
                <div className="shrink-0 text-right text-xs text-stone-500">
                  <p>{l.user_name ?? "sistema"}</p>
                  <p>{utcParaLocal(l.created_at)}</p>
                </div>
              </li>
            ))}
          </ol>
        )}
      </Section>
    </div>
  );
}
