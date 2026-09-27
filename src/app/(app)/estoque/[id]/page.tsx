import Link from "next/link";
import AvailabilityFilter from "@/components/AvailabilityFilter";
import { availabilityQuery, addMinutes, type AvailabilityParams } from "@/lib/availability-time";
import { stockOptions } from "@/lib/availability-settings";
import { dateTimeBR } from "@/lib/format";
import { notFound } from "next/navigation";
import { all, one } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { availabilityFor, availabilityForDays, componentsOf, holdsForProduct, kitsUsing } from "@/lib/stock";
import { logsFor } from "@/lib/audit";
import { UNIT_STATUS } from "@/lib/domain";
import { addDays, dateBR, money, today, utcParaLocal } from "@/lib/format";
import { Alerta, Badge, Card, Empty, LinkButton, PageHeader, Row, Section, Stat, StatusBadge } from "@/components/ui";
import { SubmitButton } from "@/components/SubmitButton";
import { addUnits, closeMaintenance, deleteProduct, deleteUnit, openMaintenance, setUnitStatus, toggleProduct } from "../actions";

export const dynamic = "force-dynamic";

export default async function ProdutoPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<AvailabilityParams & { aviso?: string }>;
}) {
  const user = await requireUser();
  const { id } = await params;
  const sp = await searchParams;
  const { aviso } = sp;
  const query = availabilityQuery(sp);
  const options = await stockOptions(query);
  const p = await one<any>(
    `SELECT p.*, c.name AS category FROM products p LEFT JOIN categories c ON c.id = p.category_id WHERE p.id = ?`,
    [Number(id)],
  );
  if (!p) notFound();

  const d0 = query.from.slice(0, 10);
  /*
   * Uma serie em lote (hoje + 14 dias) substitui as 15 chamadas de
   * availabilityFor que a tela fazia — dezenas de consultas ao D1 viram um
   * numero fixo pequeno. O restante das leituras sai em paralelo.
   */
  const serie = await availabilityForDays(p.id, query.from, query.to, 15, options);
  const [hoje, ...proximosBruto] = serie;
  const proximos = proximosBruto.map((a, i) => ({
    date: addDays(d0, i + 1),
    from: addMinutes(query.from, (i + 1) * 1440),
    to: addMinutes(query.to, (i + 1) * 1440),
    ...a,
  }));
  const ehKit = p.kind === "kit";
  const [units, maint, historicoBruto, componentes, kitsQueUsam, usos] = await Promise.all([
    all<any>(`SELECT * FROM product_units WHERE product_id = ? ORDER BY code`, [p.id]),
    all<any>(`SELECT * FROM maintenance WHERE product_id = ? ORDER BY status, id DESC LIMIT 20`, [p.id]),
    logsFor("produto", p.id),
    ehKit ? componentsOf(p.id) : Promise.resolve([]),
    ehKit ? Promise.resolve([]) : kitsUsing(p.id),
    all<any>(
      `SELECT COUNT(*) AS reservas, COALESCE(SUM(i.qty),0) AS unidades, COALESCE(SUM(i.subtotal_cents),0) AS receita
       FROM reservation_items i JOIN reservations r ON r.id = i.reservation_id
      WHERE i.product_id = ? AND r.status <> 'cancelada'`,
      [p.id],
    ).then((rows) => rows[0]),
  ]);
  historicoBruto.length = Math.min(historicoBruto.length, 10);
  const historico = historicoBruto;
  const holds = (
    await Promise.all(
      (ehKit
        ? componentes.map((c: any) => ({ id: c.component_product_id, name: c.component_name }))
        : [{ id: p.id, name: p.name }]
      ).map(async (c: any) =>
        (await holdsForProduct(c.id, query.from, addMinutes(query.to, 60 * 1440), null, null, options)).map((h) => ({
          ...h,
          physicalName: c.name,
        })),
      ),
    )
  ).flat();

  return (
    <div className="space-y-4">
      <PageHeader
        title={p.name}
        subtitle={`${p.code} · ${p.category ?? "sem categoria"}`}
        action={
          <>
            <LinkButton href={`/estoque/${p.id}/editar`}>Editar</LinkButton>
            <LinkButton href={`/disponibilidade?${query.queryString}`} variant="secundario">Consultar Disponibilidade</LinkButton>
          </>
        }
      />

      <AvailabilityFilter query={query} minutes={options.preparationMinutes} />
      {aviso === "componente" && (
        <Alerta tone="ambar" title="Produto inativado">
          Este produto faz parte da composição de um ou mais kits, por isso foi inativado em vez de excluído.
        </Alerta>
      )}
      {aviso === "inativado" && (
        <Alerta tone="ambar" title="Produto inativado">
          O produto já foi usado em reservas, por isso foi inativado em vez de excluído.
        </Alerta>
      )}
      {!p.active && <Alerta tone="ambar">Produto inativo: não aparece em novas reservas.</Alerta>}
      {hoje.low && <Alerta tone="vermelho">Disponibilidade abaixo do minimo configurado ({p.min_qty}).</Alerta>}

      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <Stat label={ehKit ? "Estoque próprio" : "Total"} value={ehKit ? "-" : p.total_qty} />
        <Stat label="Reservado na consulta" value={ehKit ? "-" : hoje.reserved} />
        <Stat
          label={ehKit ? "Kits Montáveis na Consulta" : "Disponível na consulta"}
          value={Math.max(0, hoje.available)}
          tone={hoje.available <= 0 ? "vermelho" : "verde"}
        />
        <Stat label="Em manutenção" value={ehKit ? "-" : p.maintenance_qty} />
      </div>

      {ehKit && (
        <Section title="Composição do kit">
          <p className="mb-2 text-smtext-stone-600">Este kit não possui estoque próprio. Alugar 1 unidade consome os itens abaixo, e a disponibilidade é
            calculada a partir deles.
          </p>
          {componentes.length === 0 ? (
            <Alerta tone="vermelho">
              Kit sem composição definida. Edite o produto e informe os componentes.
            </Alerta>
          ) : (
            <ul className="divide-y divide-nuvem-200">
              {componentes.map((c: any) => (
                <li key={c.id} className="flex items-center justify-between gap-3 py-2">
                  <Link href={`/estoque/${c.component_product_id}?${query.queryString}`} className="min-w-0">
                    <span className="block truncate text-sm font-semibold text-marca-600">{c.component_name}</span>
                    <span className="block text-xs text-stone-500">
                      {c.component_code} · estoque total {c.total_qty} un.
                    </span>
                  </Link>
                  <span className="shrink-0 text-sm font-bold text-tinta-900">{c.quantity} por kit</span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}

      {!ehKit && kitsQueUsam.length > 0 && (
        <Section title={`Kits que usam este produto (${kitsQueUsam.length})`}>
          <ul className="divide-y divide-nuvem-200">
            {kitsQueUsam.map((k: any) => (
              <li key={k.id} className="flex items-center justify-between gap-3 py-2">
                <Link href={`/estoque/${k.id}?${query.queryString}`} className="min-w-0 truncate text-sm font-semibold text-marca-600">
                  {k.name}
                </Link>
                <span className="shrink-0 text-sm text-stone-500">{k.quantity} un. por kit</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-stone-500">
            Alugar esses kits consome o estoque deste produto.
          </p>
        </Section>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="Dados do produto">
          <Row label="Código" value={p.code} />
          <Row label="Tipo" value={ehKit ? "Kit / produto composto" : "Produto simples"} />
          <Row label="Categoria" value={p.category ?? "-"} />
          <Row label="Valor de locação" value={money(p.rent_price_cents)} />
          <Row label="Valor de reposição" value={money(p.replace_cents)} />
          <Row label="Estoque mínimo" value={p.min_qty} />
          <Row label="Reservas já feitas" value={`${usos.reservas} (${usos.unidades} un.)`} />
          <Row label="Receita acumulada" value={money(usos.receita)} />
          {p.description && <Row label="Descrição" value={p.description} />}
          {p.photo && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={p.photo} alt={p.name} className="mt-3 max-h-48 rounded-xl object-contain" />
          )}
        </Section>

        <Section title="Disponibilidade dos próximos 14 dias">
          <p className="mb-2 text-xs text-stone-500">A mesma consulta deslocada dia a dia, mantendo os horarios e a duracao. Preparacao: {options.preparationMinutes} min.</p>
          <div className="grid grid-cols-7 gap-1.5">
            {proximos.map((d) => (
              <div
                key={d.date}
                className={`rounded-lg p-1.5 text-center ${
                  d.available <= 0 ? "bg-red-100 text-red-800" : d.low ? "bg-amber-100 text-amber-800" : "bg-emerald-50 text-emerald-800"
                }`}
                title={`${dateTimeBR(d.from)} até ${dateTimeBR(d.to)}: ${d.available} disponível`}
              >
                <p className="text-[0.6rem] font-semibold">{d.date.slice(8, 10)}/{d.date.slice(5, 7)}</p>
                <p className="text-sm font-bold leading-tight">{Math.max(0, d.available)}</p>
              </div>
            ))}
          </div>

          <h3 className="mb-1.5 mt-4 text-xs font-bold uppercase text-stone-500">Reservas que ocupam este item</h3>
          {holds.length === 0 ? (
            <Empty>Nenhuma reserva futura ocupa este produto.</Empty>
          ) : (
            <ul className="divide-y divide-nuvem-200">
              {holds.slice(0, 15).map((h, i) => (
                <li key={`${h.reservation_id}-${i}`} className="flex items-center justify-between py-2 text-sm">
                  <Link href={`/reservas/${h.reservation_id}`} className="min-w-0">
                    <span className="block truncate font-semibold text-marca-600">{h.number} - {h.customer}</span>
                    <span className="block text-xs text-stone-500">
                      {dateTimeBR(h.hold_start)} até {dateTimeBR(h.hold_end)} — {h.physicalName}
                    </span>
                  </Link>
                  <span className="shrink-0 font-bold">{h.qty} un.</span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>

      {!ehKit && (
      <div className="grid gap-4 lg:grid-cols-2">
        <Section title={`Unidades individuais (${units.length})`}>
          <form action={addUnits} className="mb-3 flex flex-wrap gap-2">
            <input type="hidden" name="product_id" value={p.id} />
            <input name="qty" type="number" min={1} max={200} defaultValue={1} className="campo w-24" />
            <input name="value" placeholder="Valor un. (R$)" inputMode="decimal" className="campo w-40" />
            <SubmitButton variant="secundario">Gerar códigos</SubmitButton>
          </form>

          {units.length === 0 ? (
            <Empty>
              Nenhuma unidade individual. Gere códigos ({p.code}-001, {p.code}-002…) para controlar item a item.
            </Empty>
          ) : (
            <div className="max-h-96 space-y-1.5 overflow-y-auto">
              {units.map((u) => (
                <div key={u.id} className="flex items-center gap-2 rounded-xl border border-nuvem-300 bg-white p-2">
                  <span className="w-24 shrink-0 font-mono text-xs font-bold">{u.code}</span>
                  <StatusBadge defs={UNIT_STATUS} value={u.status} />
                  <form action={setUnitStatus} className="ml-auto flex items-center gap-1">
                    <input type="hidden" name="unit_id" value={u.id} />
                    <select name="status" defaultValue={u.status} className="rounded-lg border border-nuvem-300 px-2 py-1 text-xs">
                      {UNIT_STATUS.map((s) => (
                        <option key={s.value} value={s.value}>
                          {s.label}
                        </option>
                      ))}
                    </select>
                    <SubmitButton variant="secundario" className="px-2 py-1 text-xs">
                      Ok
                    </SubmitButton>
                  </form>
                  {user.role === "admin" && (
                    <form action={deleteUnit}>
                      <input type="hidden" name="unit_id" value={u.id} />
                      <SubmitButton variant="perigo" confirm={`Remover ${u.code}?`} className="px-2 py-1 text-xs">
                        x
                      </SubmitButton>
                    </form>
                  )}
                </div>
              ))}
            </div>
          )}
          <p className="mt-2 text-xs text-stone-400">
            Os códigos ficam prontos para etiquetas com QR Code no futuro.
          </p>
        </Section>

        <Section title="Manutenção">
          <form action={openMaintenance} className="grid grid-cols-2 gap-2">
            <input type="hidden" name="product_id" value={p.id} />
            <input name="qty" type="number" min={1} defaultValue={1} placeholder="Qtd" className="campo" />
            <input name="started_at" type="date" defaultValue={d0} className="campo" />
            <input name="reason" placeholder="Motivo" className="campo col-span-2" />
            <input name="cost" placeholder="Custo (R$)" inputMode="decimal" className="campo" />
            <select name="product_unit_id" className="campo">
              <option value="">Sem unidade especifica</option>
              {units.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.code}
                </option>
              ))}
            </select>
            <div className="col-span-2">
              <SubmitButton className="w-full">Enviar para Manutenção</SubmitButton>
            </div>
          </form>

          <div className="mt-3">
            {maint.length === 0 ? (
              <Empty>Nenhuma manutenção registrada.</Empty>
            ) : (
              <ul className="divide-y divide-nuvem-200">
                {maint.map((mt) => (
                  <li key={mt.id} className="flex items-center justify-between gap-2 py-2 text-sm">
                    <span className="min-w-0">
                      <span className="block truncate font-semibold">
                        {mt.qty} un. · {mt.reason || "sem motivo"}
                      </span>
                      <span className="block text-xs text-stone-500">
                        {dateBR(mt.started_at)}
                        {mt.ended_at ? ` até ${dateBR(mt.ended_at)}` : ""} · {money(mt.cost_cents)}
                      </span>
                    </span>
                    {mt.status === "aberta" ? (
                      <form action={closeMaintenance}>
                        <input type="hidden" name="id" value={mt.id} />
                        <SubmitButton variant="sucesso" className="px-3 py-1.5 text-xs">
                          Concluir
                        </SubmitButton>
                      </form>
                    ) : (
                      <Badge tone="cinza">Concluída</Badge>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Section>
      </div>
      )}

      {historico.length > 0 && (
        <Section title="Histórico">
          <ul className="space-y-1.5 text-sm">
            {historico.map((h: any) => (
              <li key={h.id} className="flex gap-2 text-stone-600">
                <span className="shrink-0 text-xs text-stone-400">{utcParaLocal(h.created_at)}</span>
                <span>{h.summary}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {user.role === "admin" && (
        <Card className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm font-semibold text-tinta-900">Área do administrador</p>
          <div className="flex gap-2">
            <form action={toggleProduct}>
              <input type="hidden" name="id" value={p.id} />
              <SubmitButton variant="secundario">{p.active ? "Inativar" : "Reativar"}</SubmitButton>
            </form>
            <form action={deleteProduct}>
              <input type="hidden" name="id" value={p.id} />
              <SubmitButton variant="perigo" confirm={`Excluir o produto ${p.name}?`}>
                Excluir
              </SubmitButton>
            </form>
          </div>
        </Card>
      )}
    </div>
  );
}
