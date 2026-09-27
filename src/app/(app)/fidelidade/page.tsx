import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { all } from "@/lib/db";
import { regraAtual, mensagensPendentes, importarHistorico } from "@/lib/fidelidade-db";
import { progresso, resumoProgresso, situacao, diasAte } from "@/lib/fidelidade";
import { dateBR, money, today, waLink } from "@/lib/format";
import { Alerta, Badge, Card, Empty, LinkButton, PageHeader, Section, Stat } from "@/components/ui";
import { Icon } from "@/components/Icons";
import { importarHistoricoFidelidade, marcarMensagem } from "./actions";
import { SubmitButton } from "@/components/SubmitButton";

export const dynamic = "force-dynamic";

export default async function FidelidadePage({
  searchParams,
}: {
  searchParams: Promise<{ importado?: string; recompensas?: string }>;
}) {
  const user = await requireUser();
  const sp = await searchParams;
  const regra = await regraAtual();
  const d0 = today();

  // uma consulta para todo o quadro, em vez de uma por cliente
  const clientes = await all<any>(
    `SELECT c.id, c.name, c.phone, c.whatsapp,
            COALESCE((SELECT SUM(e.delta) FROM fidelity_events e WHERE e.customer_id = c.id),0) AS pontos
       FROM customers c
      WHERE c.active = 1
        AND EXISTS (SELECT 1 FROM fidelity_events e WHERE e.customer_id = c.id)
      ORDER BY pontos DESC, c.name`,
  );
  const recompensas = await all<any>(
    `SELECT r.*, c.name AS customer_name FROM fidelity_rewards r JOIN customers c ON c.id = r.customer_id
      ORDER BY r.id DESC LIMIT 100`,
  );
  const pendentes = await mensagensPendentes();
  // o que existe de locacao concluida ainda fora do programa
  const aImportar = await importarHistorico({ simular: true });

  const comSituacao = recompensas.map((r: any) => ({ ...r, situacao: situacao(r, d0) }));
  const disponiveis = comSituacao.filter((r: any) => r.situacao === "disponivel");
  const usadas = comSituacao.filter((r: any) => r.situacao === "usada");
  const quaseLa = clientes
    .map((c: any) => ({ ...c, p: progresso(c.pontos, regra) }))
    .filter((c: any) => c.p.faltam === 1);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Programa de Fidelidade"
        subtitle={`A cada ${regra.meta} locações, até ${regra.kits} kits grátis`}
        action={<LinkButton href="/configuracoes?aba=fidelidade">Configurar</LinkButton>}
      />

      {!regra.ativo && (
        <Alerta tone="ambar" title="Programa desativado">
          Novas locações não pontuam. As recompensas já conquistadas continuam válidas.
        </Alerta>
      )}

      {sp.importado !== undefined && (
        <Alerta tone="verde" title="Histórico Importado">
          {Number(sp.importado) === 0
            ? "Nenhuma locação nova para importar: o histórico já estava todo no programa."
            : `${sp.importado} locação(ões) do histórico entraram no programa, gerando ${sp.recompensas ?? 0} recompensa(s). Nenhum cliente foi avisado automaticamente: use as mensagens prontas para falar com quem você quiser.`}
        </Alerta>
      )}

      {aImportar.locacoes > 0 && (
        <Card>
          <p className="text-sm font-bold text-tinta-900">
            {aImportar.locacoes} locação(ões) já concluídas estão fora do programa
          </p>
          <p className="mt-0.5 text-xs text-stone-500">
            São {aImportar.clientes} cliente(s) que já alugaram antes de o programa existir. Importar conta essas
            locações e gera {aImportar.recompensas} recompensa(s) na hora. Ninguém é avisado automaticamente.
          </p>

          {aImportar.porCliente.length > 0 && (
            <details className="mt-2">
              <summary className="cursor-pointer text-xs font-semibold text-marca-600">
                Ver quem será afetado
              </summary>
              <ul className="mt-1.5 max-h-56 space-y-0.5 overflow-y-auto text-sm">
                {aImportar.porCliente.map((c) => (
                  <li key={c.customer_id} className="flex justify-between gap-3">
                    <Link href={`/clientes/${c.customer_id}`} className="truncate text-marca-600">
                      {c.name}
                    </Link>
                    <span className="shrink-0 text-xs text-stone-500">
                      +{c.locacoes} locação(ões)
                      {c.recompensas > 0 ? ` · ${c.recompensas} recompensa(s)` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          )}

          {user.role === "admin" ? (
            <form action={importarHistoricoFidelidade} className="mt-3">
              <SubmitButton
                confirm={`Importar ${aImportar.locacoes} locação(ões) e gerar ${aImportar.recompensas} recompensa(s)? Isso concede benefício de verdade aos clientes.`}
              >
                Importar Histórico
              </SubmitButton>
            </form>
          ) : (
            <p className="mt-2 text-xs text-stone-500">Somente o administrador pode importar o histórico.</p>
          )}
        </Card>
      )}

      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <Stat label="Clientes no programa" value={clientes.length} />
        <Stat label="A 1 locação da meta" value={quaseLa.length} tone={quaseLa.length > 0 ? "ambar" : undefined} />
        <Stat label="Recompensas disponíveis" value={disponiveis.length} tone="verde" />
        <Stat label="Recompensas usadas" value={usadas.length} />
      </div>

      {pendentes.length > 0 && (
        <Section title={`Mensagens para enviar (${pendentes.length})`}>
          <p className="mb-2 text-xs text-stone-500">
            O envio é pelo WhatsApp, no mesmo caminho que vocês já usam. Marcar como enviada tira daqui.
          </p>
          <ul className="space-y-2">
            {pendentes.map((m: any) => (
              <li key={m.id} className="rounded-xl border border-nuvem-300 bg-white p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Link href={`/clientes/${m.customer_id}`} className="text-sm font-bold text-marca-600">
                    {m.customer_name}
                  </Link>
                  <Badge tone="cinza">{m.event}</Badge>
                </div>
                <p className="mt-1 text-sm text-stone-700">{m.body}</p>
                <div className="mt-2 flex flex-wrap items-center gap-3">
                  {(m.whatsapp || m.phone) && (
                    <a
                      href={waLink(m.whatsapp || m.phone, m.body) ?? "#"}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1.5 text-sm font-semibold text-marca-600"
                    >
                      <Icon name="whatsapp" className="h-4 w-4" /> Abrir no WhatsApp
                    </a>
                  )}
                  <form action={marcarMensagem}>
                    <input type="hidden" name="id" value={m.id} />
                    <input type="hidden" name="status" value="enviada" />
                    <SubmitButton variant="secundario" className="px-2.5 py-1.5 text-xs">
                      Marcar como enviada
                    </SubmitButton>
                  </form>
                  <form action={marcarMensagem}>
                    <input type="hidden" name="id" value={m.id} />
                    <input type="hidden" name="status" value="dispensada" />
                    <SubmitButton variant="secundario" className="px-2.5 py-1.5 text-xs">
                      Dispensar
                    </SubmitButton>
                  </form>
                </div>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {disponiveis.length > 0 && (
        <Section title={`Recompensas disponíveis (${disponiveis.length})`}>
          <ul className="divide-y divide-nuvem-200">
            {disponiveis.map((r: any) => {
              const dias = diasAte(r.expires_on, d0);
              return (
                <li key={r.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <span className="min-w-0">
                    <Link href={`/clientes/${r.customer_id}`} className="block font-semibold text-marca-600">
                      {r.customer_name}
                    </Link>
                    <span className="block text-xs text-stone-500">
                      até {r.kit_quantity} kits · conquistada em {dateBR(r.earned_at)}
                    </span>
                  </span>
                  {r.expires_on ? (
                    <Badge tone={dias !== null && dias <= 3 ? "vermelho" : "ambar"}>
                      vence em {dateBR(r.expires_on)}
                    </Badge>
                  ) : (
                    <Badge tone="verde">sem validade</Badge>
                  )}
                </li>
              );
            })}
          </ul>
        </Section>
      )}

      <Section title={`Clientes no programa (${clientes.length})`}>
        {clientes.length === 0 ? (
          <Empty>Nenhum cliente pontuou ainda. A pontuação entra quando a locação é concluída.</Empty>
        ) : (
          <ul className="divide-y divide-nuvem-200">
            {clientes.map((c: any) => {
              const p = progresso(c.pontos, regra);
              return (
                <li key={c.id} className="py-2.5">
                  <div className="flex items-center justify-between gap-3">
                    <Link href={`/clientes/${c.id}`} className="text-sm font-semibold text-marca-600">
                      {c.name}
                    </Link>
                    <span className="text-xs text-stone-500">{resumoProgresso(p, regra.kits)}</span>
                  </div>
                  <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-nuvem-200">
                    <div
                      className={`h-full ${p.faltam === 1 ? "bg-amber-500" : "bg-marca-600"}`}
                      style={{ width: `${Math.min(100, Math.round((p.noCiclo / p.meta) * 100))}%` }}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Section>
    </div>
  );
}
