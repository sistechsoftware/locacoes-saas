import Link from "next/link";
import { dateBR, money, utcParaLocal, waLink } from "@/lib/format";
import { diasAte, resumoProgresso, type Progresso, type Regra } from "@/lib/fidelidade";
import { Alerta, Badge, Card, Section } from "@/components/ui";
import { Icon } from "@/components/Icons";

/**
 * Fidelidade no cadastro do cliente.
 *
 * Mostra onde o cliente esta no ciclo, o que ele ja ganhou e o texto pronto
 * para mandar no WhatsApp. O envio continua manual, pelo mesmo caminho que a
 * empresa ja usa para falar com o cliente.
 */
export function FidelidadeCliente({
  regra,
  progresso,
  recompensas,
  mensagens,
  historico,
  telefone,
  hoje,
}: {
  regra: Regra;
  progresso: Progresso;
  recompensas: any[];
  mensagens: any[];
  historico: any[];
  telefone: string | null;
  hoje: string;
}) {
  if (!regra.ativo && recompensas.length === 0) return null;

  const disponiveis = recompensas.filter((r) => r.situacao === "disponivel");
  const pct = Math.round((progresso.noCiclo / progresso.meta) * 100);
  const pendentes = mensagens.filter((m) => m.status === "pendente");

  const TOM: Record<string, "verde" | "ambar" | "vermelho" | "cinza"> = {
    disponivel: "verde",
    usada: "cinza",
    expirada: "ambar",
    cancelada: "vermelho",
  };

  return (
    <Section title="Programa de Fidelidade">
      {!regra.ativo && (
        <Alerta tone="ambar" title="Programa desativado">
          Novas locações não pontuam. As recompensas abaixo continuam válidas.
        </Alerta>
      )}

      <Card>
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-2xl font-bold text-tinta-900">
            {progresso.noCiclo}/{progresso.meta}
          </span>
          <span className="text-sm text-stone-600">{resumoProgresso(progresso, regra.kits)}</span>
        </div>
        <div className="mt-2 h-2.5 overflow-hidden rounded-full bg-nuvem-200">
          <div className="h-full bg-marca-600 transition-all" style={{ width: `${Math.min(100, pct)}%` }} />
        </div>
        <p className="mt-2 text-xs text-stone-500">
          {progresso.pontos} locação(ões) elegível(is) no total
          {progresso.ciclosCompletos > 0 ? ` · ${progresso.ciclosCompletos} ciclo(s) fechado(s)` : ""}
        </p>
      </Card>

      {disponiveis.length > 0 && (
        <Alerta tone="verde" title={`Recompensa disponível (${disponiveis.length})`}>
          <ul className="space-y-1">
            {disponiveis.map((r) => {
              const dias = diasAte(r.expires_on, hoje);
              return (
                <li key={r.id}>
                  Até {r.kit_quantity} kits grátis, conquistada em {dateBR(r.earned_at)}
                  {r.expires_on && (
                    <span className={dias !== null && dias <= 3 ? "font-bold text-red-700" : ""}>
                      {" "}
                      · vale até {dateBR(r.expires_on)}
                      {dias !== null && dias >= 0 ? ` (${dias} dia${dias === 1 ? "" : "s"})` : ""}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
          <p className="mt-1 text-xs">Para usar, abra a reserva do cliente e aplique a recompensa lá.</p>
        </Alerta>
      )}

      {pendentes.length > 0 && telefone && (
        <Card>
          <p className="mb-2 text-sm font-semibold text-tinta-900">Mensagens prontas para enviar</p>
          <ul className="space-y-2">
            {pendentes.map((m) => (
              <li key={m.id} className="rounded-xl border border-nuvem-300 bg-white p-3">
                <p className="text-sm text-stone-700">{m.body}</p>
                <a
                  href={waLink(telefone, m.body) ?? "#"}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-2 inline-flex items-center gap-1.5 text-sm font-semibold text-marca-600"
                >
                  <Icon name="whatsapp" className="h-4 w-4" /> Enviar no WhatsApp
                </a>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {recompensas.length > 0 && (
        <div className="mt-3">
          <p className="mb-1 text-xs font-semibold uppercase text-stone-500">Recompensas</p>
          <ul className="divide-y divide-nuvem-200">
            {recompensas.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                <span className="min-w-0">
                  <span className="block font-semibold text-tinta-900">Até {r.kit_quantity} kits grátis</span>
                  <span className="block text-xs text-stone-500">
                    conquistada em {dateBR(r.earned_at)}
                    {r.used_at && r.reservation_number && (
                      <>
                        {" "}
                        · usada em{" "}
                        <Link href={`/reservas/${r.used_reservation_id}`} className="text-marca-600">
                          {r.reservation_number}
                        </Link>
                        {r.used_discount_cents ? ` (${money(r.used_discount_cents)})` : ""}
                      </>
                    )}
                    {r.rule_goal !== progresso.meta && ` · regra da época: ${r.rule_goal} locações`}
                  </span>
                </span>
                <Badge tone={TOM[r.situacao] ?? "cinza"}>{r.situacao}</Badge>
              </li>
            ))}
          </ul>
        </div>
      )}

      {historico.length > 0 && (
        <details className="mt-3">
          <summary className="cursor-pointer text-xs font-semibold text-marca-600">
            Ver histórico de pontuação ({historico.length})
          </summary>
          <ul className="mt-2 space-y-1 text-sm">
            {historico.map((h) => (
              <li key={h.id} className="flex gap-2 text-stone-600">
                <span className="shrink-0 text-xs text-stone-400">{utcParaLocal(h.created_at)}</span>
                <span>
                  <b className={h.delta > 0 ? "text-emerald-700" : "text-red-700"}>
                    {h.delta > 0 ? "+" : ""}
                    {h.delta}
                  </b>{" "}
                  {h.notes}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </Section>
  );
}
