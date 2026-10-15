import Link from "next/link";
import { notFound } from "next/navigation";
import { requireModule } from "@/lib/auth";
import {
  chamadoDaEmpresa,
  labelCategoria,
  marcarVisto,
  mensagensDoChamado,
  prioridadeDaEmpresa,
  STATUS_CHAMADO,
} from "@/lib/suporte";
import { Alerta, Badge, LinkButton, PageHeader, StatusBadge } from "@/components/ui";
import { fecharChamadoAction, reabrirChamadoAction, responderChamadoEmpresaAction } from "../actions";

export const dynamic = "force-dynamic";

function dataHoraBR(sql: string | null) {
  if (!sql) return "—";
  const [dia, hora] = sql.slice(0, 16).split(" ");
  return `${dia.split("-").reverse().join("/")}${hora ? ` ${hora}` : ""}`;
}

function anexoHref(fileId: string, nome: string | null) {
  return `/api/suporte/arquivo/${fileId}?download=1&nome=${encodeURIComponent(nome ?? "anexo")}`;
}

/** Conversa de um chamado da PRÓPRIA empresa (barreira de tenant na lib). */
export default async function ChamadoPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ erro?: string }>;
}) {
  const { user } = await requireModule("suporte");
  const { id: idRaw } = await params;
  const sp = await searchParams;
  const id = Number(idRaw);
  if (!Number.isInteger(id) || id <= 0) notFound();

  const ticket = await chamadoDaEmpresa(id, user.company_id);
  if (!ticket) notFound();

  await marcarVisto(id, "empresa", user);
  const [mensagens, prioridade] = await Promise.all([
    mensagensDoChamado(id),
    prioridadeDaEmpresa(user.company_id),
  ]);

  return (
    <div className="space-y-4">
      <PageHeader
        title={`Chamado #${ticket.id}`}
        subtitle={ticket.subject}
        action={
          <LinkButton href="/suporte" variant="secundario">
            Voltar
          </LinkButton>
        }
      />

      {sp.erro && <Alerta tone="vermelho">{sp.erro}</Alerta>}

      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge defs={STATUS_CHAMADO} value={ticket.status} />
        <Badge tone="cinza">{labelCategoria(ticket.category)}</Badge>
        {prioridade === "prioritario" && <Badge tone="terracota">Prioritário</Badge>}
        {ticket.plano_abertura && <Badge tone="cinza">plano na abertura: {ticket.plano_abertura}</Badge>}
      </div>

      <div className="grid gap-2 text-xs text-stone-500 sm:grid-cols-3">
        <p>
          Aberto em <b className="text-stone-700">{dataHoraBR(ticket.created_at)}</b>
        </p>
        <p>
          1ª resposta do suporte:{" "}
          <b className="text-stone-700">{ticket.first_response_at ? dataHoraBR(ticket.first_response_at) : "—"}</b>
        </p>
        <p>
          Última atividade: <b className="text-stone-700">{dataHoraBR(ticket.updated_at)}</b>
        </p>
      </div>

      <div className="space-y-3">
        {mensagens.map((m) => {
          const meu = m.author_kind === "empresa";
          return (
            <div
              key={m.id}
              className={`cartao p-4 ${meu ? "border-l-4 border-l-marca-400" : "border-l-4 border-l-sky-400 bg-sky-50/40"}`}
            >
              <div className="flex flex-wrap items-center gap-2 text-xs text-stone-500">
                <span className="font-bold text-tinta-900">
                  {meu ? (m.author_name ?? "Equipe") : "Suporte Locô"}
                </span>
                <Badge tone={meu ? "cinza" : "azul"}>{meu ? "empresa" : "suporte"}</Badge>
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

      {ticket.status !== "resolvido" ? (
        <div className="space-y-3">
          <form action={responderChamadoEmpresaAction} className="cartao space-y-3 p-4">
            <input type="hidden" name="chamado" value={ticket.id} />
            <label className="rotulo">Responder</label>
            <textarea
              name="texto"
              className="campo min-h-24"
              maxLength={4000}
              placeholder="Escreva sua resposta…"
            />
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

          <form action={fecharChamadoAction} className="text-right">
            <input type="hidden" name="chamado" value={ticket.id} />
            <button className="text-xs font-semibold text-stone-500 underline hover:text-tinta-900">
              Marcar como resolvido
            </button>
          </form>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-stone-500">Este chamado está resolvido.</p>
          <form action={reabrirChamadoAction}>
            <input type="hidden" name="chamado" value={ticket.id} />
            <button className="rounded-xl border border-nuvem-300 bg-white px-4 py-2 text-sm font-semibold text-tinta-900 hover:bg-nuvem-50">
              Reabrir chamado
            </button>
          </form>
        </div>
      )}

      <p className="text-xs text-stone-400">
        Precisa de algo mais? Também estamos no <Link href="/faturamento" className="text-marca-600 underline">Faturamento</Link>{" "}
        para questões de assinatura.
      </p>
    </div>
  );
}
