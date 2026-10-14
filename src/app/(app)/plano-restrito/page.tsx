import Link from "next/link";
import { requireCompanyContext } from "@/lib/auth";
import { planoDaEmpresa } from "@/lib/plano-gate";
import { NOME_DO_PLANO, RECURSOS, ehPlanoValido, planoMinimoPara, type Recurso } from "@/lib/planos";

export const dynamic = "force-dynamic";

/**
 * Tela explicativa do gate de RECURSOS CONTRATADOS (correção de planos).
 *
 * requireModule redireciona para /plano-restrito?recurso=<slug> quando a
 * página pede um módulo que a empresa não contratou. Contextual e discreta:
 * explica o que falta, mostra o plano atual e aponta o MESMO fluxo de
 * upgrade já existente (/faturamento), sem virar anúncio repetido.
 *
 * Nota de segurança: quem chega aqui autenticado vê apenas a explicação — o
 * conteúdo do módulo é barrado no backend (requireModuleEdit/actions e
 * apiUser/rotas), então acessar a URL de um recurso pago por digitação
 * direta não devolve dado algum.
 */
export default async function PlanoRestritoPage({
  searchParams,
}: {
  searchParams: Promise<{ recurso?: string }>;
}) {
  // Página da área interna: assinatura bloqueada redireciona (modo página).
  const ctx = await requireCompanyContext();
  const { recurso: recursoRaw } = await searchParams;

  const recurso: Recurso | null =
    typeof recursoRaw === "string" && recursoRaw in RECURSOS && !RECURSOS[recursoRaw as Recurso].fundamental
      ? (recursoRaw as Recurso)
      : null;

  const slug = await planoDaEmpresa(ctx.companyId);
  const planoAtual = ehPlanoValido(slug) ? NOME_DO_PLANO[slug] : "não identificado";
  const planoQueLibera = recurso ? NOME_DO_PLANO[planoMinimoPara(recurso)] : null;
  const dono = ctx.user.role === "owner";

  return (
    <div className="mx-auto max-w-lg py-10">
      <div className="cartao p-6 text-center">
        <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-amber-100 text-3xl">
          🔒
        </div>
        <h1 className="text-xl font-black text-tinta-900">
          {recurso ? `${RECURSOS[recurso].nome}: recurso não incluído no plano` : "Recurso não incluído no plano"}
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-tinta-700">
          {recurso ? (
            <>
              Este recurso faz parte do plano <b>{planoQueLibera}</b>. Sua empresa está no plano{" "}
              <b>{planoAtual}</b>, que não o inclui.
            </>
          ) : (
            <>Este recurso não está incluído no plano atual da sua empresa.</>
          )}{" "}
          Tudo o que seu plano oferece continua funcionando normalmente.
        </p>

        <div className="mt-5 flex flex-col gap-2">
          {dono ? (
            <Link
              href="/faturamento"
              className="rounded-xl bg-marca-600 px-4 py-2.5 text-sm font-bold text-white transition hover:bg-marca-700"
            >
              Ver planos e fazer upgrade
            </Link>
          ) : (
            <p className="rounded-xl bg-nuvem-100 px-4 py-2.5 text-sm text-tinta-700">
              Peça ao proprietário da empresa para fazer o upgrade em <b>Assinatura</b>.
            </p>
          )}
          <Link
            href="/dashboard"
            className="rounded-xl border border-nuvem-300 px-4 py-2.5 text-sm font-semibold text-tinta-700 transition hover:bg-nuvem-50"
          >
            Voltar ao início
          </Link>
        </div>
      </div>
    </div>
  );
}
