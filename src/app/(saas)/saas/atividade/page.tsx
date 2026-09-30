import { atividadeRecentePainel } from "@/lib/billing";
import { Card, Empty } from "@/components/ui";

export const dynamic = "force-dynamic";

function dataHoraBR(sql: string | null) {
  if (!sql) return "—";
  const [dia, hora] = sql.slice(0, 16).split(" ");
  return `${dia.split("-").reverse().join("/")}${hora ? ` ${hora}` : ""}`;
}

/** Atividade administrativa global (audit_logs) — quem fez o quê e quando. */
export default async function SaasAtividadePage() {
  const atividade = await atividadeRecentePainel(100);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-black tracking-tight text-tinta-900">Atividade recente</h1>
        <p className="text-sm text-stone-500">Log de auditoria global da plataforma (logins, ações comerciais e de suporte).</p>
      </div>

      <Card>
        {atividade.length === 0 ? (
          <Empty>Sem registros ainda.</Empty>
        ) : (
          <div className="divide-y divide-stone-100">
            {atividade.map((a) => (
              <div key={a.id} className="py-2.5">
                <div className="text-sm text-tinta-900">{a.summary}</div>
                <div className="text-xs text-stone-500">
                  {a.user_name ?? "sistema"} · {a.action} · {a.entity}
                  {a.entity_id !== null ? `#${a.entity_id}` : ""} · {dataHoraBR(a.created_at)}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
