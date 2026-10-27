import Link from "next/link";
import { requireModule } from "@/lib/auth";
import { all } from "@/lib/db";
import { PageHeader, Empty, Badge, Alerta } from "@/components/ui";
import { SubmitButton } from "@/components/SubmitButton";
import { TIPOS_EMAIL, type TipoEmail } from "@/lib/email-notificacoes";
import { MOTIVOS_TEXTO } from "@/lib/email-queue";
import type { Tone } from "@/lib/domain";
import { reprocessarEmailAction } from "../actions";

export const dynamic = "force-dynamic";

/** Estado do envio para a tela: rótulo + tom, coerente com o ciclo de vida real. */
const ESTADOS: Record<string, { rotulo: string; tom: Tone }> = {
  pendente: { rotulo: "Pendente", tom: "ambar" },
  enviando: { rotulo: "Enviando", tom: "azul" },
  enviado: { rotulo: "Enviado (aceito pelo provedor)", tom: "verde" },
  falha_temporaria: { rotulo: "Falha temporária — nova tentativa", tom: "ambar" },
  falha_definitiva: { rotulo: "Falha definitiva", tom: "vermelho" },
  cancelado: { rotulo: "Cancelado", tom: "cinza" },
  ignorado: { rotulo: "Ignorado", tom: "cinza" },
};

const STATUS_FILTRO = Object.keys(ESTADOS);

type Linha = {
  id: number;
  type: string;
  source: string;
  source_id: number | null;
  reservation_id: number | null;
  reservation_number: string | null;
  recipient: string;
  subject: string;
  status: string;
  motivo: string | null;
  attempts: number;
  scheduled_at: number;
  next_attempt: number;
  last_error: string | null;
  provider_id: string | null;
  sent_at: number | null;
  created_at: number;
  updated_at: number;
};

const dataHora = (s: number | null | undefined) =>
  s ? new Date(s * 1000).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }) : "—";

/**
 * Histórico de e-mails da EMPRESA autenticada.
 *
 * Escopo: company_id da sessão em toda query — o histórico de outro tenant é
 * inacessível por construção (nenhum id de URL passa por aqui sem o filtro).
 * Quem pode ver é o módulo Notificações (todos os papéis); o reprocessamento
 * é ação de escrita e passa pela matriz de permissões na action.
 */
export default async function HistoricoEmailsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; tipo?: string; erro?: string; ok?: string }>;
}) {
  const ctx = await requireModule("notificacoes");
  const cid = ctx.companyId;
  const sp = await searchParams;
  const status = STATUS_FILTRO.includes(sp.status ?? "") ? String(sp.status) : "";
  const tipo = sp.tipo && sp.tipo in TIPOS_EMAIL ? String(sp.tipo) : "";

  const linhas = await all<Linha>(
    `SELECT e.id, e.type, e.source, e.source_id, e.reservation_id, e.recipient, e.subject, e.status,
            e.motivo, e.attempts, e.scheduled_at, e.next_attempt, e.last_error, e.provider_id,
            e.sent_at, e.created_at, e.updated_at, r.number AS reservation_number
       FROM email_notifications e
       LEFT JOIN reservations r ON r.id = e.reservation_id AND r.company_id = e.company_id
      WHERE e.company_id = ? ${status ? "AND e.status = ?" : ""} ${tipo ? "AND e.type = ?" : ""}
      ORDER BY e.id DESC
      LIMIT 100`,
    [cid, ...(status ? [status] : []), ...(tipo ? [tipo] : [])],
  );

  const opcoesTipo = (Object.keys(TIPOS_EMAIL) as TipoEmail[]).map((t) => ({
    valor: t,
    rotulo: TIPOS_EMAIL[t].rotulo,
  }));

  const total = linhas.length;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Histórico de e-mails"
        subtitle="Envios, falhas e notificações ignoradas desta empresa"
        action={
          <Link href="/configuracoes?aba=notificacoes" className="text-sm text-marca-600 underline">
            Configurar e-mails
          </Link>
        }
      />

      <div className="flex flex-wrap gap-3 text-sm text-marca-600 underline">
        <Link href="/notificacoes">Central de notificações</Link>
        <Link href="/notificacoes/preferencias">Preferências</Link>
        <Link href="/notificacoes/alertas">Alertas gerais</Link>
      </div>

      {sp.erro && <Alerta tone="vermelho">{sp.erro}</Alerta>}
      {sp.ok && <Alerta tone="verde">{sp.ok}</Alerta>}

      <form className="pilha-filtros">
        <select name="status" defaultValue={status} className="campo min-w-0 flex-1 basis-48 sm:flex-none sm:max-w-64">
          <option value="">Todos os estados</option>
          {STATUS_FILTRO.map((s) => (
            <option key={s} value={s}>
              {ESTADOS[s].rotulo}
            </option>
          ))}
        </select>
        <select name="tipo" defaultValue={tipo} className="campo min-w-0 flex-1 basis-48 sm:flex-none sm:max-w-64">
          <option value="">Todos os tipos</option>
          {opcoesTipo.map((t) => (
            <option key={t.valor} value={t.valor}>
              {t.rotulo}
            </option>
          ))}
        </select>
        <button className="w-full rounded-xl border px-4 py-2 sm:w-auto">Filtrar</button>
      </form>

      {!total && <Empty>Nenhum e-mail registrado neste filtro.</Empty>}

      {linhas.map((l) => {
        const def = ESTADOS[l.status] ?? { rotulo: l.status, tom: "cinza" as const };
        const reprocessavel = l.status === "falha_temporaria" || l.status === "falha_definitiva";
        const origem =
          l.source === "reserva"
            ? `Reserva ${l.reservation_number ?? (l.source_id ? `#${l.source_id}` : "")}`
            : l.source === "operacao"
              ? `Operação ${l.source_id ? `#${l.source_id}` : ""}`
              : l.source === "fidelidade"
                ? `Fidelidade · cliente #${l.source_id ?? ""}`
                : "Configurações";
        return (
          <article key={l.id} className="cartao p-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <h2 className="font-bold">{TIPOS_EMAIL[l.type as TipoEmail]?.rotulo ?? l.type}</h2>
                <p className="text-sm text-stone-600">
                  {l.subject || "—"} · <b>{l.recipient || "sem destinatário"}</b>
                </p>
              </div>
              <Badge tone={def.tom}>{def.rotulo}</Badge>
            </div>

            <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1 text-xs text-stone-600 sm:grid-cols-2">
              <div>
                <dt className="inline font-semibold">Origem: </dt>
                <dd className="inline">{origem}</dd>
              </div>
              <div>
                <dt className="inline font-semibold">Criado: </dt>
                <dd className="inline">{dataHora(l.created_at)}</dd>
              </div>
              <div>
                <dt className="inline font-semibold">Agendado para: </dt>
                <dd className="inline">{dataHora(l.scheduled_at)}</dd>
              </div>
              <div>
                <dt className="inline font-semibold">Última tentativa: </dt>
                <dd className="inline">
                  {l.attempts ? `${dataHora(l.updated_at)} (${l.attempts}ª)` : "não houve"}
                </dd>
              </div>
              {l.sent_at ? (
                <div>
                  <dt className="inline font-semibold">Aceito pelo provedor: </dt>
                  <dd className="inline">{dataHora(l.sent_at)}</dd>
                </div>
              ) : null}
              {l.provider_id ? (
                <div className="truncate">
                  <dt className="inline font-semibold">Id do provedor: </dt>
                  <dd className="inline">{l.provider_id}</dd>
                </div>
              ) : null}
              {l.status === "falha_temporaria" && l.next_attempt > 0 ? (
                <div>
                  <dt className="inline font-semibold">Próxima tentativa: </dt>
                  <dd className="inline">{dataHora(l.next_attempt)}</dd>
                </div>
              ) : null}
            </dl>

            {(l.motivo || l.last_error) && (
              <p className="mt-2 rounded-lg bg-stone-100 px-3 py-2 text-xs text-stone-700">
                <b>Motivo:</b> {MOTIVOS_TEXTO[l.motivo ?? ""] ?? l.motivo ?? l.last_error}
                {l.motivo && l.last_error ? ` — ${l.last_error}` : ""}
              </p>
            )}

            {reprocessavel && (
              <form action={reprocessarEmailAction} className="mt-3">
                <input type="hidden" name="id" value={l.id} />
                <SubmitButton variant="secundario" className="px-3 py-1 text-sm">
                  Reprocessar
                </SubmitButton>
              </form>
            )}
            {!reprocessavel && l.status === "enviado" && (
              <p className="mt-2 text-xs text-stone-500">
                Enviado ao provedor — este registro não pode ser reenviado para não duplicar o aviso do cliente.
              </p>
            )}
          </article>
        );
      })}

      {total === 100 && (
        <p className="text-sm text-stone-500">Mostrando os 100 registros mais recentes. Use os filtros para refinar.</p>
      )}
    </div>
  );
}
