import Link from "next/link";
import { requireUser } from "@/lib/auth";
import {
  aniversariantesDoMes,
  aniversariantesNaJanela,
  buscarAniversariantes,
  clientesSemData,
  configAniversarios,
  type Aniversariante,
} from "@/lib/aniversarios-db";
import { MODELO_PARABENS, partes, primeiroNome } from "@/lib/aniversarios";
import { getSettings, renderTemplate } from "@/lib/settings";
import { dateBR, today, waLink } from "@/lib/format";
import { Alerta, Badge, Card, Empty, LinkButton, PageHeader, Section, Stat } from "@/components/ui";
import { Icon } from "@/components/Icons";
import { SearchForm, Tabs } from "@/components/List";

export const dynamic = "force-dynamic";

const PERIODOS = [
  { value: "hoje", label: "Hoje" },
  { value: "7", label: "Próximos 7 dias" },
  { value: "15", label: "15 dias" },
  { value: "30", label: "30 dias" },
  { value: "mes", label: "Este mês" },
  { value: "proximo", label: "Próximo mês" },
];

export default async function AniversariosPage({
  searchParams,
}: {
  searchParams: Promise<{ periodo?: string; q?: string; dia?: string }>;
}) {
  await requireUser();
  const sp = await searchParams;
  const periodo = sp.periodo ?? "7";
  const q = (sp.q ?? "").trim();
  const d0 = today();
  const hojePartes = partes(d0)!;

  const [cfg, s, semData] = await Promise.all([configAniversarios(), getSettings(), clientesSemData()]);

  // cada periodo resolve numa consulta so, filtrada por dia e mes no banco
  let lista: Aniversariante[];
  let tituloLista: string;
  if (q) {
    lista = await buscarAniversariantes({ busca: q }, d0);
    tituloLista = `Resultados para "${q}"`;
  } else if (periodo === "mes" || periodo === "proximo") {
    const mes = periodo === "mes" ? hojePartes.mes : (hojePartes.mes % 12) + 1;
    const ano = periodo === "mes" || hojePartes.mes < 12 ? hojePartes.ano : hojePartes.ano + 1;
    lista = await aniversariantesDoMes(ano, mes, d0);
    tituloLista = periodo === "mes" ? "Aniversariantes deste mês" : "Aniversariantes do próximo mês";
  } else {
    const dias = periodo === "hoje" ? 0 : Math.max(0, Number(periodo) || 7);
    lista = await aniversariantesNaJanela(dias, d0);
    tituloLista = dias === 0 ? "Aniversariantes de hoje" : `Próximos ${dias} dias`;
  }

  const deHoje = lista.filter((a) => a.dias === 0);
  const proximos = lista.filter((a) => a.dias > 0);

  // agrupa por data, que e como a lista fica util para quem vai ligar
  const porData = new Map<string, Aniversariante[]>();
  for (const a of proximos) porData.set(a.data, [...(porData.get(a.data) ?? []), a]);

  const base = `/aniversarios?${new URLSearchParams(q ? { q } : {}).toString()}`;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Aniversariantes"
        subtitle={`Avisos com ${cfg.diasAntecedencia} dia(s) de antecedência`}
        action={<LinkButton href="/configuracoes?aba=aniversarios">Configurar</LinkButton>}
      />

      {!cfg.ativo && (
        <Alerta tone="ambar" title="Avisos desativados">
          A tela continua funcionando, mas o sistema não gera aviso automático. Ative em Configurações.
        </Alerta>
      )}

      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
        <Stat label="Aniversariantes hoje" value={deHoje.length} tone={deHoje.length > 0 ? "verde" : undefined} />
        <Stat label="Na lista atual" value={lista.length} />
        <Stat label="Sem data cadastrada" value={semData} tone={semData > 0 ? "ambar" : undefined} />
      </div>

      <SearchForm action="/aniversarios" placeholder="Nome ou telefone do cliente…" defaultValue={q} />
      {!q && <Tabs items={PERIODOS} current={periodo} base={base} param="periodo" />}

      {deHoje.length > 0 && (
        <section className="cartao overflow-hidden">
          <header className="border-b border-nuvem-200 bg-emerald-50 px-4 py-2.5">
            <h2 className="text-sm font-bold uppercase tracking-wide text-emerald-800">
              Aniversariantes de hoje ({deHoje.length})
            </h2>
          </header>
          <ul className="divide-y divide-nuvem-200">
            {deHoje.map((a) => (
              <Pessoa key={a.id} a={a} empresa={s.company_name} destaque />
            ))}
          </ul>
        </section>
      )}

      <Section title={q ? tituloLista : proximos.length > 0 ? "Próximos aniversariantes" : tituloLista}>
        {lista.length === 0 ? (
          <Empty>
            {semData > 0
              ? `Ninguém faz aniversário neste período. ${semData} cliente(s) ainda estão sem data de nascimento cadastrada.`
              : "Ninguém faz aniversário neste período."}
          </Empty>
        ) : porData.size === 0 && deHoje.length > 0 ? (
          <p className="text-sm text-stone-500">Nenhum outro aniversário neste período.</p>
        ) : (
          <div className="space-y-3">
            {[...porData.entries()].map(([data, pessoas]) => (
              <div key={data}>
                <p className="mb-1 text-xs font-bold uppercase tracking-wide text-stone-500">
                  {dateBR(data)}
                  <span className="ml-2 font-normal normal-case text-stone-400">
                    {pessoas[0].dias === 1 ? "amanhã" : `em ${pessoas[0].dias} dias`}
                  </span>
                </p>
                <ul className="divide-y divide-nuvem-200 rounded-xl border border-nuvem-200 bg-white">
                  {pessoas.map((a) => (
                    <Pessoa key={a.id} a={a} empresa={s.company_name} />
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </Section>

      {semData > 0 && (
        <Card>
          <p className="text-sm text-stone-600">
            <b>{semData}</b> cliente(s) ativos ainda não têm data de nascimento cadastrada. A data é opcional, mas quem
            não tem nunca aparece aqui.{" "}
            <Link href="/clientes" className="font-semibold text-marca-600">
              Ver clientes
            </Link>
          </p>
        </Card>
      )}
    </div>
  );
}

function Pessoa({ a, empresa, destaque }: { a: Aniversariante; empresa: string; destaque?: boolean }) {
  const parabens = renderTemplate(MODELO_PARABENS, {
    cliente_nome: primeiroNome(a.name),
    empresa_nome: empresa,
  });
  const zap = a.whatsapp || a.phone;
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5">
      <div className="min-w-0">
        <Link href={`/clientes/${a.id}`} className="block truncate text-sm font-bold text-marca-600">
          {a.name}
        </Link>
        <p className="text-xs text-stone-500">
          {dateBR(a.birth_date)}
          {a.idadeQueCompleta !== null && (
            <> · {destaque ? `completa ${a.idadeQueCompleta} anos hoje` : `completa ${a.idadeQueCompleta} anos`}</>
          )}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {destaque && <Badge tone="verde">hoje</Badge>}
        {zap && (
          <a
            href={waLink(zap, parabens) ?? "#"}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 rounded-lg border border-nuvem-300 bg-white px-2.5 py-1.5 text-xs font-semibold"
          >
            <Icon name="whatsapp" className="h-3.5 w-3.5" /> Parabenizar
          </a>
        )}
        <Link
          href={`/clientes/${a.id}`}
          className="rounded-lg border border-nuvem-300 bg-white px-2.5 py-1.5 text-xs font-semibold"
        >
          Ver Cliente
        </Link>
      </div>
    </li>
  );
}
