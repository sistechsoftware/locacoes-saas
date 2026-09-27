import { freightsOn, lateFreights, lateOperations, operationsBetween, ordenarOperacoesMistas } from "@/lib/queries";
import { requireUser } from "@/lib/auth";
import { addDays, dateBR, today } from "@/lib/format";
import { Card, Empty, LinkButton, PageHeader } from "@/components/ui";
import { OperationCard } from "@/components/OperationCard";
import { FreightCard } from "@/components/FreightCard";
import { Tabs } from "@/components/List";

export const dynamic = "force-dynamic";

const ABAS = [
  { value: "entregas", label: "Entregas", kind: "entrega" },
  { value: "retiradas", label: "Retiradas", kind: "retirada" },
  { value: "montagens", label: "Montagens", kind: "montagem" },
  { value: "desmontagens", label: "Desmontagens", kind: "desmontagem" },
  { value: "fretes", label: "Fretes", kind: null },
  { value: "todas", label: "Todas", kind: null },
  { value: "atrasadas", label: "Atrasadas", kind: null },
];

export default async function OperacaoPage({
  searchParams,
}: {
  searchParams: Promise<{ aba?: string; data?: string; dias?: string }>;
}) {
  await requireUser();
  const sp = await searchParams;
  const aba = sp.aba ?? "entregas";
  const data = sp.data || today();
  const dias = Math.max(0, Math.min(30, Number(sp.dias ?? 0)));
  const ate = addDays(data, dias);

  // Uma leitura do periodo cobre a aba aberta e os numeros de todas as abas:
  // consultar cada tipo separadamente custava seis idas ao banco. Os fretes
  // entram na mesma leitura paralela, pela mesma janela de datas (regra da
  // agenda: so o cancelado fica de fora).
  const [atrasadas, fretesAtrasados, doPeriodo, fretesPeriodo] = await Promise.all([
    lateOperations(),
    lateFreights(),
    operationsBetween(data, ate),
    freightsOn(data, ate),
  ]);
  const def = ABAS.find((a) => a.value === aba) ?? ABAS[0];
  const ops =
    aba === "atrasadas"
      ? ordenarOperacoesMistas([...atrasadas, ...fretesAtrasados])
      : aba === "fretes"
        ? fretesPeriodo
        : def.kind
          ? doPeriodo.filter((o: any) => o.kind === def.kind)
          : // "Todas" representa tudo que roda no periodo: locacoes e fretes
            // na mesma linha do tempo, com a ordenacao unica do sistema.
            ordenarOperacoesMistas([...doPeriodo, ...fretesPeriodo]);

  const contar = (kind: string) => doPeriodo.filter((o: any) => o.kind === kind).length;
  const contagem = {
    entregas: contar("entrega"),
    retiradas: contar("retirada"),
    montagens: contar("montagem"),
    desmontagens: contar("desmontagem"),
    fretes: fretesPeriodo.length,
    todas: doPeriodo.length + fretesPeriodo.length,
    atrasadas: atrasadas.length + fretesAtrasados.length,
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="Entregas e Retiradas"
        subtitle={dias === 0 ? dateBR(data) : `${dateBR(data)} até ${dateBR(ate)}`}
        action={<LinkButton href="/operacao/nova" variant="primario">+ Nova Operação</LinkButton>}
      />

      <Card>
        {/* Os campos dividem a largura em partes iguais e o rotulo fica inteiro
            em cima — antes, "Data" e "Proximos dias" colidiam no celular */}
        <form className="pilha-filtros">
          <input type="hidden" name="aba" value={aba} />
          <label className="min-w-0 flex-1 basis-40">
            <span className="rotulo">Data</span>
            <input type="date" name="data" defaultValue={data} className="campo data-hora" />
          </label>
          <label className="min-w-0 flex-1 basis-40">
            <span className="rotulo">Próximos dias</span>
            <select name="dias" defaultValue={String(dias)} className="campo">
              <option value="0">Somente este dia</option>
              <option value="1">+1 dia</option>
              <option value="3">+3 dias</option>
              <option value="7">+7 dias</option>
              <option value="30">+30 dias</option>
            </select>
          </label>
          <button className="w-full rounded-xl bg-marca-600 px-5 py-2.5 text-sm font-semibold text-white sm:w-auto">Filtrar</button>
        </form>
      </Card>

      <Tabs
        items={ABAS.map((a) => ({ value: a.value, label: a.label, count: (contagem as any)[a.value] }))}
        current={aba}
        base={`/operacao?data=${data}&dias=${dias}`}
      />

      {ops.length === 0 ? (
        <Empty>Nenhuma operação neste filtro.</Empty>
      ) : (
        <div className="space-y-2">
          {ops.map((o: any) =>
            aba === "fretes" || o.kind === "frete" ? (
              // kind entra na chave: operacoes e fretes vem de tabelas
              // diferentes e podem compartilhar o mesmo id numerico.
              <FreightCard key={`${o.kind}-${o.id}`} f={o} showDate={dias > 0 || aba === "atrasadas"} />
            ) : (
              <OperationCard key={`${o.kind}-${o.id}`} op={o} showDate={dias > 0 || aba === "atrasadas"} />
            ),
          )}
        </div>
      )}
    </div>
  );
}
