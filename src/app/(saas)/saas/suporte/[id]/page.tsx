import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePlatformAdmin } from "@/lib/auth";
import {
  chamadoDaPlataforma,
  labelCategoria,
  marcarVisto,
  mensagensDoChamado,
  prioridadeDaEmpresa,
  STATUS_CHAMADO,
} from "@/lib/suporte";
import { Alerta, Badge, LinkButton, PageHeader, StatusBadge } from "@/components/ui";
import { definirStatusSuporteAction, responderSuportePlataformaAction } from "../actions";

export const dynamic = "force-dynamic";

function dataHoraBR(sql: string | null) {
  if (!sql) return "—";
  const [dia, hora] = sql.slice(0, 16).split(" ");
  return `${dia.split("-").reverse().join("/")}${hora ? ` ${hora}` : ""}`;
}

function anexoHref(fileId: string, nome: string | null) {
  return `/api/suporte/arquivo/${fileId}?download=1&nome=${encodeURIComponent(nome ?? "anexo")}`;
}

/** Contexto capturado na abertura (plano, papel e erros recentes da empresa). */
function contextoDe(ticket: { context: string | null }): { plano?: string; papel?: string; erros?: { id: number; message: string; route: string | null }[] } {
  if (!ticket.context) return {};
  try {
    return JSON.parse(ticket.context);
  } catch {
    return {};
  }
}

/** Detalhe do chamado no painel: conversa, resposta e mudança de status. */
export default async function SaasChamadoPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ erro?: string }>;
}) {
  const user = await requirePlatformAdmin();
  const { id: idRaw } = await params;
  const sp = await searchParams;
  const id = Number(idRaw);
  if (!Number.isInteger(id) || id <= 0) notFound();

  const ticket = await chamadoDaPlataforma(id);
  if (!ticket) notFound();

  await marcarVisto(id, "suporte", user);
  const [mensagens, prioridade] = await Promise.all([
    mensagensDoChamado(id),
    prioridadeDaEmpresa(ticket.company_id),
  ]);
  const contexto = contextoDe(ticket);

  return (
    <div className="space-y-4">
      <PageHeader
        title={`Chamado #${ticket.id}`}
        subtitle={ticket.subject}
        action={
          <LinkButton href="/saas/suporte" variant="secundario">
            Fila
          </LinkButton>
        }
      />

      {sp.erro && <Alerta tone="vermelho">{sp.erro}</Alerta>}

      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge defs={STATUS_CHAMADO} value={ticket.status} />
        <Badge tone="cinza">{labelCategoria(ticket.category)}</Badge>
        {prioridade === "prioritario" && <Badge tone="terracota">Prioritário</Badge>}
        {ticket.status !== "resolvido" && !ticket.first_response_at && (
          <Badge tone="vermelho">aguardando 1ª resposta</Badge>
        )}
      </div>

      <div className="cartao space-y-1.5 p-4 text-xs text-stone-500">
        <p>
          <Link href={`/saas/empresas/${ticket.company_id}`} className="font-bold text-marca-600 underline">
            {ticket.company_name ?? `Empresa #${ticket.company_id}`}
          </Link>
          {" · "}
          {ticket.plan_slug ? <b className="uppercase text-tinta-900">{ticket.plan_slug}</b> : "sem plano identificado"}
          {" · "}aberto em <b className="text-stone-700">{dataHoraBR(ticket.created_at)}</b>
        </p>
        <p>
          1ª resposta: <b className="text-stone-700">{ticket.first_response_at ? dataHoraBR(ticket.first_response_at) : "—"}</b>
          {" · "}resolvido em: <b className="text-stone-700">{ticket.resolved_at ? dataHoraBR(ticket.resolved_at) : "—"}</b>
          {" · "}plano na abertura: <b className="text-stone-700">{ticket.plano_abertura ?? "—"}</b>
        </p>
        {!!contexto.erros?.length && (
          <div className="rounded-xl border border-nuvem-200 bg-nuvem-50 p-2.5">
            <p className="font-bold uppercase tracking-wide text-stone-500">Erros registrados na abertura</p>
            <ul className="mt-1 space-y-0.5">
              {contexto.erros.map((e) => (
                <li key={e.id} className="font-mono text-[0.7rem] text-stone-600">
                  {e.route ? `${e.route} — ` : ""}
                  {e.message}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <div className="space-y-3">
        {mensagens.map((m) => {
          const daEmpresa = m.author_kind === "empresa";
          return (
            <div
              key={m.id}
              className={`cartao p-4 ${daEmpresa ? "border-l-4 border-l-marca-400" : "border-l-4 border-l-sky-400 bg-sky-50/40"}`}
            >
              <div className="flex flex-wrap items-center gap-2 text-xs text-stone-500">
                <span className="font-bold text-tinta-900">
                  {daEmpresa ? (m.author_name ?? "Empresa") : "Suporte (equipe)"}
                </span>
                <Badge tone={daEmpresa ? "cinza" : "azul"}>{daEmpresa ? "empresa" : "suporte"}</Badge>
                <span className="ml-auto text-stone-400">{dataHoraBR(m.created_at)}</span>
              </div>
              {m.body && <p className="mt-2 whitespace-pre-wrap break-words text-sm text-tinta-900">{m.body}</p>}
              {m.file_id && (
                <a
                  href={anexoHref(m.file_id, m.file_name)}
                  className="mt-2 inline-block text-sm font-semibold text-marca-600 underline"
                >
                  📎 {m.file_name ?? "anexo"} {m.file_size ? `(${Math.ceil(m.file_size / 1024)} KB)` : ""}
                </a>
              )}
            </div>
          );
        })}
      </div>

      <form action={responderSuportePlataformaAction} className="cartao space-y-3 p-4">
        <input type="hidden" name="chamado" value={ticket.id} />
        <label className="rotulo">Responder (equipe de suporte)</label>
        <textarea name="texto" className="campo min-h-24" maxLength={4000} placeholder="Resposta ao cliente…" />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <input type="file" name="arquivo" className="text-xs" />
          <button
            type="submit"
            className="rounded-xl bg-marca-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-marca-700"
          >
            Enviar resposta
          </button>
        </div>
      </form>

      <form action={definirStatusSuporteAction} className="cartao flex flex-wrap items-end gap-3 p-4">
        <input type="hidden" name="chamado" value={ticket.id} />
        <div className="grow">
          <label className="rotulo">Status do chamado</label>
          <select name="status" className="campo" defaultValue={ticket.status}>
            {STATUS_CHAMADO.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" className="rounded-xl border border-nuvem-300 bg-white px-4 py-2.5 text-sm font-semibold text-tinta-900 hover:bg-nuvem-50">
          Salvar status
        </button>
      </form>
    </div>
  );
}
