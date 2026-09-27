import Link from "next/link";
import { revalidatePath } from "next/cache";
import { assertAdmin, requireUser } from "@/lib/auth";
import { contarErros, ERROS_POR_PAGINA, ultimosErros } from "@/lib/error-log";
import { alternarResolvido } from "./actions";
import { PageHeader, Badge, Empty } from "@/components/ui";
import { Pagination } from "@/components/List";

export const dynamic = "force-dynamic";

/**
 * Diario de erros do servidor, visivel dentro do proprio sistema.
 *
 * Duas abas: Servidor (onRequestError + cron) e Navegador (erros de client
 * reportados pelos boundaries). Marcar como resolvido tira o erro da contagem
 * sem apagar o historico — a manutencao decide quando o problema parou de
 * importar, os dados ficam ate a poda de 30 dias.
 */
function dataHora(unix: number) {
  return new Date(unix * 1000).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
}

function contextoBonito(row: any): string {
  if (!row?.context) return "";
  try {
    const c = JSON.parse(row.context);
    return Object.entries(c)
      .filter(([, v]) => v !== null && v !== undefined && v !== "")
      .map(([k, v]) => `${k}: ${v}`)
      .join(" · ");
  } catch {
    return "";
  }
}

export default async function ErrosPage({
  searchParams,
}: {
  searchParams: Promise<{ aba?: string; page?: string }>;
}) {
  const user = await requireUser();
  const sp = await searchParams;
  const aba = sp.aba === "client" ? "client" : "server";
  const page = Math.max(1, Number(sp.page ?? 1));

  const [total, rows] = await Promise.all([
    contarErros(aba),
    ultimosErros(aba, ERROS_POR_PAGINA, (page - 1) * ERROS_POR_PAGINA),
  ]);
  const ehAdmin = user.role === "admin";

  return (
    <div className="space-y-4">
      <PageHeader
        title="Diário de erros"
        subtitle={`${total} erro(s) sem tratamento nesta aba · retenção de 30 dias`}
        action={
          <Link
            href="/erros?aba=client"
            className={`rounded-xl border border-nuvem-300 px-3 py-2 text-sm ${aba === "client" ? "bg-white font-medium" : ""}`}
          >
            Ver navegador
          </Link>
        }
      />

      {rows.length === 0 ? (
        <Empty>Nenhum erro registrado nesta aba. 🎉</Empty>
      ) : (
        <div className="space-y-2">
          {rows.map((e) => {
            const ctx = contextoBonito(e);
            return (
              <div key={e.id} className="cartao p-4 space-y-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={e.resolved ? "cinza" : "vermelho"}>{e.resolved ? "Resolvido" : "Aberto"}</Badge>
                  <Badge tone={e.kind === "server" ? "ambar" : "azul"}>
                    {e.source === "onRequestError" ? "servidor" : e.source === "cron" ? "cron" : "navegador"}
                  </Badge>
                  {e.route && <Badge tone="cinza">{e.route}</Badge>}
                  {e.method && <span className="text-xs text-slate-400">{e.method}</span>}
                  <span className="ml-auto text-xs text-slate-400">{dataHora(e.created_at)}</span>
                </div>
                <p className="break-words font-mono text-sm">{e.message}</p>
                {(e.user_name || e.digest || ctx) && (
                  <p className="text-xs text-slate-500">
                    {[e.user_name, e.digest ? `digest ${e.digest}` : "", ctx].filter(Boolean).join(" · ")}
                  </p>
                )}
                {ehAdmin && (
                  <form action={alternarResolvido} className="pt-1">
                    <input type="hidden" name="id" value={e.id} />
                    <input type="hidden" name="resolvido" value={e.resolved ? "0" : "1"} />
                    <button className="text-xs text-blue-600 hover:underline">
                      {e.resolved ? "Reabrir" : "Marcar como resolvido"}
                    </button>
                  </form>
                )}
              </div>
            );
          })}
        </div>
      )}

      <Pagination
        page={page}
        total={total}
        perPage={ERROS_POR_PAGINA}
        build={(p) => `/erros?aba=${aba}&page=${p}`}
      />
    </div>
  );
}
