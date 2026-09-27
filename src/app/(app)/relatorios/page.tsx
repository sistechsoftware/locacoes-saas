import Link from "next/link";
import { all, scalar } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { ACTIVE_STATUSES } from "@/lib/domain";
import { addDays, dateBR, endOfMonth, money, startOfMonth, startOfWeek, today } from "@/lib/format";
import { Card, Empty, PageHeader, Section, Stat } from "@/components/ui";
import { Tabs } from "@/components/List";

export const dynamic = "force-dynamic";
const ACTIVE = ACTIVE_STATUSES.map((s) => `'${s}'`).join(",");

function periodo(nome: string, de?: string, ate?: string) {
  const d0 = today();
  switch (nome) {
    case "hoje":
      return { de: d0, ate: d0, label: "Hoje" };
    case "semana":
      return { de: startOfWeek(d0), ate: addDays(startOfWeek(d0), 6), label: "Esta Semana" };
    case "ano":
      return { de: `${d0.slice(0, 4)}-01-01`, ate: `${d0.slice(0, 4)}-12-31`, label: "Este ano" };
    case "personalizado":
      return { de: de || startOfMonth(d0), ate: ate || endOfMonth(d0), label: "Período personalizado" };
    default:
      return { de: startOfMonth(d0), ate: endOfMonth(d0), label: "Este Mês" };
  }
}

export default async function RelatoriosPage({
  searchParams,
}: {
  searchParams: Promise<{ p?: string; de?: string; ate?: string }>;
}) {
  await requireUser();
  const sp = await searchParams;
  const p = sp.p ?? "mes";
  const { de, ate, label } = periodo(p, sp.de, sp.ate);

  /*
   * Nenhuma destas leituras depende da outra, e cada ida ao D1 custa uma volta
   * pela rede. Buscadas juntas, o relatorio passa a pagar uma latencia so.
   */
  const [
    recebido,
    faturado,
    fretes,
    despesas,
    aReceber,
    locacoes,
    canceladas,
    entregasQtd,
    retiradasQtd,
    montagensQtd,
    fretesQtd,
    consumoFisico,
    produtos,
    melhores,
    recorrentes,
    inativos,
    meses,
  ] = await Promise.all([
    scalar<number>(`SELECT COALESCE(SUM(amount_cents),0) FROM payments WHERE paid_at BETWEEN ? AND ?`, [de, ate]),
    scalar<number>(
      `SELECT COALESCE(SUM(total_cents),0) FROM reservations WHERE event_date BETWEEN ? AND ? AND status IN (${ACTIVE})`,
      [de, ate],
    ),
    scalar<number>(
      `SELECT COALESCE(SUM(amount_cents),0) FROM freights
        WHERE date BETWEEN ? AND ? AND status IN ('agendado','em_rota','concluido')`,
      [de, ate],
    ),
    scalar<number>(`SELECT COALESCE(SUM(amount_cents),0) FROM expenses WHERE date BETWEEN ? AND ?`, [de, ate]),
    scalar<number>(
      `SELECT COALESCE(SUM(r.total_cents - COALESCE((SELECT SUM(pa.amount_cents) FROM payments pa WHERE pa.reservation_id = r.id),0)),0)
         FROM reservations r WHERE r.status IN (${ACTIVE}) AND r.event_date BETWEEN ? AND ?`,
      [de, ate],
    ),
    scalar<number>(`SELECT COUNT(*) FROM reservations WHERE event_date BETWEEN ? AND ? AND status <> 'cancelada'`, [de, ate]),
    scalar<number>(`SELECT COUNT(*) FROM reservations WHERE event_date BETWEEN ? AND ? AND status = 'cancelada'`, [de, ate]),
    /* contagens sargable: comparacao direta na coluna (usa idx_op_kind e
       idx_op_sched) em vez de substr() na coluna, que forca varredura */
    scalar<number>(
      `SELECT COUNT(*) FROM operations WHERE kind = 'entrega' AND scheduled_at BETWEEN ? AND ? AND status <> 'cancelada'`,
      [`${de}T00:00`, `${ate}T23:59`],
    ),
    scalar<number>(
      `SELECT COUNT(*) FROM operations WHERE kind = 'retirada' AND scheduled_at BETWEEN ? AND ? AND status <> 'cancelada'`,
      [`${de}T00:00`, `${ate}T23:59`],
    ),
    scalar<number>(
      `SELECT COUNT(*) FROM operations WHERE kind = 'montagem' AND scheduled_at BETWEEN ? AND ? AND status <> 'cancelada'`,
      [`${de}T00:00`, `${ate}T23:59`],
    ),
    scalar<number>(`SELECT COUNT(*) FROM freights WHERE date BETWEEN ? AND ? AND status <> 'cancelado'`, [de, ate]),
    /* consumo fisico: expande kits nos componentes que realmente sairam do estoque */
    all<any>(
      `SELECT p.id, p.name, COALESCE(SUM(ric.qty),0) AS unidades, COUNT(DISTINCT r.id) AS reservas
         FROM reservation_item_components ric
         JOIN reservations r ON r.id = ric.reservation_id
         JOIN products p ON p.id = ric.product_id
        WHERE r.status <> 'cancelada' AND r.event_date BETWEEN ? AND ?
        GROUP BY p.id ORDER BY unidades DESC`,
      [de, ate],
    ),
    /* produtos (linhas comerciais: kits contam como kits).
       Os LEFT JOIN mantem na lista os produtos sem locacao, por isso a soma
       ignora explicitamente os itens cuja reserva nao casou com o filtro. */
    all<any>(
      `SELECT p.id, p.name, p.kind,
              COALESCE(SUM(CASE WHEN r.id IS NOT NULL THEN i.qty END),0) AS unidades,
              COUNT(DISTINCT r.id) AS reservas,
              COALESCE(SUM(CASE WHEN r.id IS NOT NULL THEN i.subtotal_cents END),0) AS receita
         FROM products p
         LEFT JOIN reservation_items i ON i.product_id = p.id
         LEFT JOIN reservations r ON r.id = i.reservation_id AND r.status <> 'cancelada'
                                  AND r.event_date BETWEEN ? AND ?
        GROUP BY p.id ORDER BY unidades DESC`,
      [de, ate],
    ),
    all<any>(
      `SELECT c.id, c.name, COUNT(r.id) AS locacoes, COALESCE(SUM(r.total_cents),0) AS total
         FROM customers c JOIN reservations r ON r.customer_id = c.id
        WHERE r.status IN (${ACTIVE}) AND r.event_date BETWEEN ? AND ?
        GROUP BY c.id ORDER BY total DESC LIMIT 10`,
      [de, ate],
    ),
    all<any>(
      `SELECT c.id, c.name, COUNT(r.id) AS locacoes FROM customers c JOIN reservations r ON r.customer_id = c.id
        WHERE r.status <> 'cancelada' GROUP BY c.id HAVING COUNT(r.id) >= 2 ORDER BY locacoes DESC LIMIT 10`,
    ),
    all<any>(
      `SELECT c.id, c.name, MAX(r.event_date) AS ultima FROM customers c JOIN reservations r ON r.customer_id = c.id
        WHERE r.status <> 'cancelada' GROUP BY c.id HAVING MAX(r.event_date) < ? ORDER BY ultima LIMIT 10`,
      [addDays(today(), -90)],
    ),
    all<any>(
      `SELECT substr(event_date,1,7) AS mes, COUNT(*) AS reservas, COALESCE(SUM(total_cents),0) AS total
         FROM reservations WHERE status IN (${ACTIVE}) GROUP BY mes ORDER BY mes DESC LIMIT 12`,
    ),
  ]);

  const opCount = (kind: string) =>
    kind === "entrega" ? entregasQtd : kind === "retirada" ? retiradasQtd : montagensQtd;

  const maxMes = Math.max(1, ...meses.map((m) => m.total));

  return (
    <div className="space-y-4">
      <PageHeader title="Relatórios" subtitle={`${label}: ${dateBR(de)} até ${dateBR(ate)}`} />

      <Tabs
        items={[
          { value: "hoje", label: "Hoje" },
          { value: "semana", label: "Semana" },
          { value: "mes", label: "Mês" },
          { value: "ano", label: "Ano" },
          { value: "personalizado", label: "Personalizado" },
        ]}
        current={p}
        base="/relatorios"
        param="p"
      />

      {p === "personalizado" && (
        <Card>
          <form className="pilha-filtros">
            <input type="hidden" name="p" value="personalizado" />
            <label className="min-w-0 flex-1 basis-40">
              <span className="rotulo">De</span>
              <input type="date" name="de" defaultValue={de} className="campo data-hora" />
            </label>
            <label className="min-w-0 flex-1 basis-40">
              <span className="rotulo">Até</span>
              <input type="date" name="ate" defaultValue={ate} className="campo data-hora" />
            </label>
            <button className="w-full rounded-xl bg-marca-600 px-5 py-2.5 text-sm font-semibold text-white sm:w-auto">Aplicar</button>
          </form>
        </Card>
      )}

      <div>
        <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-stone-500">Financeiro</h2>
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-6">
          <Stat label="Faturamento" value={money(faturado + fretes)} />
          <Stat label="Locações" value={money(faturado)} />
          <Stat label="Fretes" value={money(fretes)} />
          <Stat label="Recebido" value={money(recebido)} tone="verde" />
          <Stat label="Despesas" value={money(despesas)} tone="vermelho" />
          <Stat
            label="Lucro estimado"
            value={money(faturado + fretes - despesas)}
            tone={faturado + fretes - despesas >= 0 ? "verde" : "vermelho"}
          />
        </div>
      </div>

      <div>
        <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-stone-500">Operacional</h2>
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-6">
          <Stat label="Locações" value={locacoes} />
          <Stat label="Canceladas" value={canceladas} />
          <Stat label="Entregas" value={opCount("entrega")} />
          <Stat label="Retiradas" value={opCount("retirada")} />
          <Stat label="Montagens" value={opCount("montagem")} />
          <Stat label="Fretes" value={fretesQtd} />
        </div>
        <p className="mt-2 text-xs text-stone-500">A receber no período: {money(aReceber)}.</p>
      </div>

      <Section title="Faturamento por Mês">
        {meses.length === 0 ? (
          <Empty>Sem dados suficientes.</Empty>
        ) : (
          <ul className="space-y-2">
            {meses.map((m) => (
              <li key={m.mes}>
                <div className="flex items-center justify-between text-sm">
                  <span className="font-semibold text-tinta-900">{m.mes}</span>
                  <span className="text-stone-500">
                    {m.reservas} reserva(s) · <b className="text-tinta-900">{money(m.total)}</b>
                  </span>
                </div>
                <div className="mt-1 h-2 overflow-hidden rounded-full bg-nuvem-200">
                  <div className="h-full bg-marca-600" style={{ width: `${(m.total / maxMes) * 100}%` }} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="Mais alugados no período (linhas contratadas)">
          {produtos.filter((x) => x.unidades > 0).length === 0 ? (
            <Empty>Nenhuma locação no período.</Empty>
          ) : (
            <ul className="divide-y divide-nuvem-200">
              {produtos
                .filter((x) => x.unidades > 0)
                .slice(0, 10)
                .map((x) => (
                  <li key={x.id} className="flex items-center justify-between py-2 text-sm">
                    <Link href={`/estoque/${x.id}`} className="min-w-0 truncate text-marca-600">
                      {x.kind === "kit" ? "[KIT] " : ""}
                      {x.name}
                    </Link>
                    <span className="shrink-0 text-right">
                      <b className="text-tinta-900">{x.unidades} un.</b>
                      <span className="block text-xs text-stone-500">{money(x.receita)}</span>
                    </span>
                  </li>
                ))}
            </ul>
          )}
        </Section>

        <Section title="Consumo Físico de Equipamentos">
          {consumoFisico.length === 0 ? (
            <Empty>Nenhuma locação no período.</Empty>
          ) : (
            <>
              <p className="mb-2 text-xs text-stone-500">
                Kits já expandidos nos componentes: é o que realmente saiu do estoque.
              </p>
              <ul className="divide-y divide-nuvem-200">
                {consumoFisico.slice(0, 10).map((x) => (
                  <li key={x.id} className="flex items-center justify-between py-2 text-sm">
                    <Link href={`/estoque/${x.id}`} className="min-w-0 truncate text-marca-600">
                      {x.name}
                    </Link>
                    <span className="shrink-0 text-right">
                      <b className="text-tinta-900">{x.unidades} un.</b>
                      <span className="block text-xs text-stone-500">{x.reservas} reserva(s)</span>
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </Section>

        <Section title="Produtos menos alugados">
          <ul className="divide-y divide-nuvem-200">
            {produtos
              .slice()
              .sort((a, b) => a.unidades - b.unidades)
              .slice(0, 10)
              .map((x) => (
                <li key={x.id} className="flex items-center justify-between py-2 text-sm">
                  <Link href={`/estoque/${x.id}`} className="min-w-0 truncate text-marca-600">
                    {x.name}
                  </Link>
                  <span className="shrink-0 text-stone-500">{x.unidades} un.</span>
                </li>
              ))}
          </ul>
        </Section>

        <Section title="Melhores clientes do período">
          {melhores.length === 0 ? (
            <Empty>Sem dados no período.</Empty>
          ) : (
            <ul className="divide-y divide-nuvem-200">
              {melhores.map((c) => (
                <li key={c.id} className="flex items-center justify-between py-2 text-sm">
                  <Link href={`/clientes/${c.id}`} className="min-w-0 truncate text-marca-600">
                    {c.name}
                  </Link>
                  <span className="shrink-0 text-right">
                    <b className="text-tinta-900">{money(c.total)}</b>
                    <span className="block text-xs text-stone-500">{c.locacoes} locação(ões)</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Clientes recorrentes">
          {recorrentes.length === 0 ? (
            <Empty>Nenhum cliente com duas ou mais locações.</Empty>
          ) : (
            <ul className="divide-y divide-nuvem-200">
              {recorrentes.map((c) => (
                <li key={c.id} className="flex items-center justify-between py-2 text-sm">
                  <Link href={`/clientes/${c.id}`} className="min-w-0 truncate text-marca-600">
                    {c.name}
                  </Link>
                  <span className="shrink-0 text-stone-500">{c.locacoes} locações</span>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Clientes sem alugar há mais de 90 dias">
          {inativos.length === 0 ? (
            <Empty>Nenhum cliente inativo.</Empty>
          ) : (
            <ul className="divide-y divide-nuvem-200">
              {inativos.map((c) => (
                <li key={c.id} className="flex items-center justify-between py-2 text-sm">
                  <Link href={`/clientes/${c.id}`} className="min-w-0 truncate text-marca-600">
                    {c.name}
                  </Link>
                  <span className="shrink-0 text-stone-500">última em {dateBR(c.ultima)}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </div>
  );
}
