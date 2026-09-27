import Link from "next/link";
import { notFound } from "next/navigation";
import { all, one, scalar } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { logsFor } from "@/lib/audit";
import { FREIGHT_STATUS, PAYMENT_METHODS, PAYMENT_METHOD_LABEL } from "@/lib/domain";
import { dateBR, mapsLink, money, phoneBR, timeBR, today, utcParaLocal, waLink } from "@/lib/format";
import { Card, Empty, LinkButton, PageHeader, Row, Section, StatusBadge } from "@/components/ui";
import { Icon } from "@/components/Icons";
import { SubmitButton } from "@/components/SubmitButton";
import { deleteFreight, payFreight, setFreightStatus } from "../actions";

export const dynamic = "force-dynamic";

export default async function FretePage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const f = await one<any>(
    `SELECT f.*, c.name AS customer_name, c.whatsapp, v.name AS vehicle_name
       FROM freights f LEFT JOIN customers c ON c.id = f.customer_id LEFT JOIN vehicles v ON v.id = f.vehicle_id
      WHERE f.id = ?`,
    [Number(id)],
  );
  if (!f) notFound();

  // Leituras independentes em paralelo: uma latencia de rede em vez de tres.
  const [pagamentos, pago, historico] = await Promise.all([
    all<any>(`SELECT * FROM payments WHERE freight_id = ? ORDER BY id DESC`, [f.id]),
    scalar<number>(`SELECT COALESCE(SUM(amount_cents),0) FROM payments WHERE freight_id = ?`, [f.id]),
    logsFor("frete", f.id),
  ]);
  const maps = mapsLink(f.destination);
  const wa = waLink(f.whatsapp || f.phone, `Olá! Sobre o frete ${f.number} do dia ${dateBR(f.date)}.`);

  return (
    <div className="space-y-4">
      <PageHeader
        title={f.number}
        subtitle={`${f.customer_name ?? f.contact_name ?? "Sem cliente"} - ${dateBR(f.date)}`}
        action={<LinkButton href={`/fretes/${f.id}/editar`}>Editar</LinkButton>}
      />

      <Card>
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge defs={FREIGHT_STATUS} value={f.status} />
          <span className="text-sm font-bold text-tinta-900">{money(f.amount_cents)}</span>
          {pago > 0 && <span className="text-xs text-emerald-600">pago {money(pago)}</span>}
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {["agendado", "em_rota", "concluido", "cancelado"].map((s) => (
            <form key={s} action={setFreightStatus}>
              <input type="hidden" name="id" value={f.id} />
              <input type="hidden" name="status" value={s} />
              <SubmitButton
                variant={s === "concluido" ? "sucesso" : s === "cancelado" ? "perigo" : f.status === s ? "escuro" : "secundario"}
                className="w-full px-2 text-xs sm:text-sm"
              >
                {FREIGHT_STATUS.find((x) => x.value === s)!.label}
              </SubmitButton>
            </form>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {maps && (
            <a
              href={maps}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 rounded-xl bg-marca-600 px-4 py-2.5 text-sm font-semibold text-white"
            >
              <Icon name="operacao" className="h-4 w-4" /> Rota até o destino
            </a>
          )}
          {wa && (
            <a
              href={wa}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white"
            >
              <Icon name="whatsapp" className="h-4 w-4" /> WhatsApp
            </a>
          )}
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="Dados do frete">
          <Row
            label="Cliente"
            value={
              f.customer_id ? (
                <Link href={`/clientes/${f.customer_id}`} className="text-marca-600">
                  {f.customer_name}
                </Link>
              ) : (
                f.contact_name || "-"
              )
            }
          />
          <Row label="Telefone" value={phoneBR(f.phone) || "-"} />
          <Row label="Data" value={`${dateBR(f.date)}${f.time ? ` às ${timeBR(f.time)}` : ""}`} />
          <Row label="Origem" value={f.origin || "-"} />
          <Row label="Destino" value={f.destination || "-"} />
          <Row label="Carga" value={f.cargo || "-"} />
          <Row label="Veículo" value={f.vehicle_name || "-"} />
          <Row label="Forma de pagamento" value={PAYMENT_METHOD_LABEL[f.method] ?? f.method} />
          {f.notes && <Row label="Observações" value={f.notes} />}
        </Section>

        <Section title="Pagamentos">
          <form action={payFreight} className="grid grid-cols-2 gap-2">
            <input type="hidden" name="id" value={f.id} />
            <input
              name="amount"
              placeholder="Valor (R$)"
              defaultValue={((f.amount_cents - pago) / 100).toFixed(2)}
              inputMode="decimal"
              className="campo"
            />
            <input name="paid_at" type="date" defaultValue={today()} className="campo" />
            <select name="method" defaultValue={f.method} className="campo col-span-2">
              {PAYMENT_METHODS.map((m) => (
                <option key={m} value={m}>
                  {PAYMENT_METHOD_LABEL[m]}
                </option>
              ))}
            </select>
            <div className="col-span-2">
              <SubmitButton className="w-full">Registrar pagamento</SubmitButton>
            </div>
          </form>
          <div className="mt-3">
            {pagamentos.length === 0 ? (
              <Empty>Nenhum pagamento registrado.</Empty>
            ) : (
              <ul className="divide-y divide-nuvem-200">
                {pagamentos.map((p) => (
                  <li key={p.id} className="flex items-center justify-between py-2 text-sm">
                    <span>
                      {dateBR(p.paid_at)} · {PAYMENT_METHOD_LABEL[p.method] ?? p.method}
                    </span>
                    <span className="font-bold text-emerald-600">{money(p.amount_cents)}</span>
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-2 flex items-center justify-between rounded-xl bg-nuvem-100 px-3 py-2 text-sm font-bold">
              <span>Saldo</span>
              <span className={f.amount_cents - pago > 0 ? "text-red-600" : "text-emerald-600"}>
                {money(f.amount_cents - pago)}
              </span>
            </div>
          </div>
        </Section>
      </div>

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
        <Card className="flex items-center justify-between gap-3">
          <p className="text-sm font-semibold text-tinta-900">Área do administrador</p>
          <form action={deleteFreight}>
            <input type="hidden" name="id" value={f.id} />
            <SubmitButton variant="perigo" confirm={`Excluir o frete ${f.number}?`}>
              Excluir Frete
            </SubmitButton>
          </form>
        </Card>
      )}
    </div>
  );
}
