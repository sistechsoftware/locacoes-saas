import { resumoProgresso, diasAte, type Progresso, type Regra } from "@/lib/fidelidade";
import { dateBR } from "@/lib/format";

type Recompensa = {
  id: number;
  status: string;
  situacao: string;
  kit_quantity: number;
  earned_at: string;
  expires_on: string | null;
  used_at: string | null;
  used_kits: number | null;
};

/**
 * Destaque principal do portal: a evolucao no programa de fidelidade.
 *
 * A conta e a mesma de dentro do sistema: progresso/Regra vem de
 * painelDoCliente, que soma o livro-razao fidelity_events. Nada de contagem
 * paralela — o cliente ve exatamente o que a equipe ve.
 */
export default function FidelidadeHero({
  regra,
  progresso,
  recompensas,
  hoje,
}: {
  regra: Regra;
  progresso: Progresso;
  recompensas: Recompensa[];
  hoje: string;
}) {
  const pct = Math.min(100, Math.round((progresso.noCiclo / progresso.meta) * 100));
  const conquistou = progresso.noCiclo === 0 && progresso.pontos > 0;
  const disponiveis = recompensas.filter((r) => r.situacao === "disponivel");

  return (
    <section
      className={`overflow-hidden rounded-3xl shadow-lg ${
        conquistou
          ? "bg-gradient-to-br from-emerald-600 via-emerald-500 to-emerald-600"
          : "bg-gradient-to-br from-marca-800 via-marca-700 to-marca-500"
      } text-white`}
    >
      <div className="p-5 sm:p-6">
        <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-white/80">
          🎁 Seu programa de fidelidade
        </p>

        {conquistou ? (
          <>
            <p className="mt-3 text-3xl font-black leading-tight sm:text-4xl">
              🎉 Parabéns! Você conquistou uma locação grátis!
            </p>
            <p className="mt-1.5 text-sm text-white/85">
              Fale com a gente para usar na sua próxima festa — até {regra.kits} kits por conta da casa.
            </p>
          </>
        ) : (
          <>
            <p className="mt-3 flex items-baseline gap-2">
              <span className="text-4xl font-black leading-none sm:text-5xl">{progresso.noCiclo}</span>
              <span className="text-xl font-bold text-white/70">de {progresso.meta}</span>
              <span className="text-sm text-white/80">locações concluídas</span>
            </p>

            {/* etapas: preenchidas em destaque, as que faltam em vazado */}
            <div className="mt-4 flex items-center gap-2" aria-hidden>
              {Array.from({ length: progresso.meta }).map((_, i) => (
                <span
                  key={i}
                  className={`h-3.5 flex-1 rounded-full transition-all ${
                    i < progresso.noCiclo ? "bg-destaque-500" : "bg-white/20"
                  }`}
                />
              ))}
            </div>

            <div className="mt-4 h-2 overflow-hidden rounded-full bg-white/20">
              <div
                className="h-full rounded-full bg-gradient-to-r from-destaque-300 to-destaque-500 transition-all"
                style={{ width: `${pct}%` }}
              />
            </div>

            <p className="mt-3 text-sm font-semibold text-white/90">
              {progresso.faltam === 1
                ? `Falta ${progresso.faltam} locação para você ganhar sua próxima locação grátis.`
                : `Faltam ${progresso.faltam} locações para você ganhar sua próxima locação grátis.`}
            </p>
          </>
        )}

        <p className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1 text-xs font-semibold text-white/90 ring-1 ring-white/20">
          📦 Limite da recompensa: até {regra.kits} kits
        </p>
      </div>

      {disponiveis.length > 0 && (
        <div className="border-t border-white/15 bg-white/10 px-5 py-4 sm:px-6">
          <p className="text-sm font-bold">🎫 Você tem {disponiveis.length === 1 ? "uma recompensa disponível" : `${disponiveis.length} recompensas disponíveis`}</p>
          <ul className="mt-1.5 space-y-1 text-sm text-white/85">
            {disponiveis.map((r) => {
              const dias = diasAte(r.expires_on, hoje);
              return (
                <li key={r.id}>
                  Até {r.kit_quantity} kits grátis, conquistada em {dateBR(r.earned_at)}
                  {r.expires_on && (
                    <>
                      {" "}· vale até {dateBR(r.expires_on)}
                      {dias !== null && dias >= 0 ? ` (${dias} dia${dias === 1 ? "" : "s"})` : ""}
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {recompensas.length > 0 && (
        <details className="border-t border-white/15 px-5 py-3 sm:px-6">
          <summary className="cursor-pointer text-xs font-semibold text-white/80">
            Histórico de recompensas ({recompensas.length})
          </summary>
          <ul className="mt-2 space-y-2">
            {recompensas.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-2 text-sm text-white/85">
                <span>
                  Até {r.kit_quantity} kits · conquistada {dateBR(r.earned_at)}
                  {r.used_at && r.used_kits ? ` · usou ${r.used_kits} kits` : ""}
                  {r.expires_on ? ` · valia até ${dateBR(r.expires_on)}` : ""}
                </span>
                <span className="shrink-0 rounded-full bg-white/15 px-2 py-0.5 text-xs font-semibold">
                  {r.situacao}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}

      <p className="sr-only">{resumoProgresso(progresso, regra.kits)}</p>
    </section>
  );
}
