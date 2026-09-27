import { type AvailabilityQuery } from "@/lib/availability-time";

export default function AvailabilityFilter({ query, minutes, hidden = {}, fixed = false }: {
  query: AvailabilityQuery; minutes: number; hidden?: Record<string, string>; fixed?: boolean;
}) {
  /* col-span-2 alinha os dois campos na mesma grade em qualquer largura —
     antes, labels flex soltos desalinhavam o "Ate" em relacao ao "Data e
     horario da consulta" quando o rotulo quebrava em duas linhas no celular */
  return <section className="cartao p-4 space-y-2">
    <form className="grid grid-cols-1 gap-3 sm:grid-cols-2" key={query.queryString}>
      <input type="hidden" name="consulta" value="1" />
      {Object.entries(hidden).map(([name, value]) => <input key={name} type="hidden" name={name} value={value} />)}
      {!fixed && <>
        <label className="sm:col-span-1"><span className="rotulo">Data e horário da consulta</span><input required type="datetime-local" name="inicio" defaultValue={query.from} className="campo data-hora" /></label>
        <label className="sm:col-span-1"><span className="rotulo">Até (opcional: consultar um intervalo)</span><input type="datetime-local" name="fim" defaultValue={query.to === query.from ? "" : query.to} min={query.from} className="campo data-hora" /></label>
      </>}
      <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" name="preparo" value="1" defaultChecked={query.considerPreparation} />Considerar tempo de deslocamento e higienização</label>
      <div className="sm:col-span-2"><button className="w-full rounded-xl bg-marca-600 px-4 py-2.5 text-sm font-semibold text-white sm:w-auto">Consultar</button></div>
    </form>
    <p className="text-sm font-semibold">{query.label}</p>
    <p className="text-xs text-stone-500">Horário de São Paulo. {query.considerPreparation ? `Considerando ${minutes} min de deslocamento/higienização após a devolução.` : "Sem tempo adicional após a devolução."} O item libera exatamente no fim da ocupação.</p>
  </section>;
}
