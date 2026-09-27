import Link from "next/link";
import { notFound } from "next/navigation";
import { all, one } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { getOperation } from "@/lib/queries";
import { attachmentsFor } from "@/lib/uploads";
import { checklistFor } from "@/lib/checklists";
import { logsFor } from "@/lib/audit";
import { OPERATION_KINDS, OPERATION_STATUS, RESERVATION_STATUS } from "@/lib/domain";
import { dateBR, dateTimeBR, mapsLink, money, phoneBR, timeBR, utcParaLocal, waLink } from "@/lib/format";
import { Alerta, Badge, Card, Empty, LinkButton, PageHeader, Row, Section, StatusBadge } from "@/components/ui";
import { Icon } from "@/components/Icons";
import { SubmitButton } from "@/components/SubmitButton";
import ImageInput from "@/components/ImageInput";
import { RESOLUTION_LABEL } from "@/lib/danos";
import { cancelOperation, consertarDano, deletePhoto, estornarBaixaDano, reportDamage, resolverDano, saveChecklist, setOperationStatus, updateOperation } from "../actions";

export const dynamic = "force-dynamic";

export default async function OperacaoDetalhePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ erro?: string }>;
}) {
  const user = await requireUser();
  const { id } = await params;
  const { erro } = await searchParams;
  const op = await getOperation(Number(id));
  if (!op) notFound();

  const kind = OPERATION_KINDS.find((k) => k.value === op.kind)!;
  const itens = op.reservation_id
    ? await all<any>(
        `SELECT i.*, p.name AS product_name, p.id AS product_id FROM reservation_items i
           JOIN products p ON p.id = i.product_id WHERE i.reservation_id = ? ORDER BY p.name`,
        [op.reservation_id],
      )
    : [];
  const vehicles = await all<any>(`SELECT id, name FROM vehicles WHERE active = 1 ORDER BY name`);
  const users = await all<{id:number;name:string}>("SELECT id,name FROM users WHERE active=1 ORDER BY name");
  const checklist = await one<any>(`SELECT * FROM checklists WHERE operation_id = ? ORDER BY id DESC LIMIT 1`, [op.id]);
  const marcados: Record<string, boolean> = checklist ? JSON.parse(checklist.data) : {};
  const fotos = await attachmentsFor("operacao", op.id);
  const itensChecklist = checklistFor(op.kind);
  const danos = op.reservation_id
    ? await all<any>(
        `SELECT d.*, p.name AS product_name, p.kind AS product_kind FROM damage_reports d LEFT JOIN products p ON p.id = d.product_id
          WHERE d.reservation_id = ? ORDER BY d.id DESC`,
        [op.reservation_id],
      )
    : [];
  const historico = (await logsFor("operacao", op.id)).slice(0, 10);

  const maps = mapsLink(op.address, op.district, op.city);
  const wa = waLink(
    op.whatsapp || op.phone,
    `Olá, ${(op.customer ?? "").split(" ")[0]}! Sobre a ${kind.label.toLowerCase()} de hoje às ${timeBR(op.scheduled_at)}.`,
  );
  const ehRetirada = op.kind === "retirada" || op.kind === "desmontagem";

  return (
    <div className="space-y-4">
      <PageHeader
        title={`${kind.icon} ${kind.label}`}
        subtitle={`${dateBR(op.scheduled_at)} às ${timeBR(op.scheduled_at)} · ${op.customer ?? "sem cliente"}`}
        action={
          op.reservation_id ? <LinkButton href={`/reservas/${op.reservation_id}`}>Ver reserva</LinkButton> : undefined
        }
      />

      {erro && <Alerta tone="vermelho" title="Não foi possível concluir">{erro}</Alerta>}

      <Card>
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge defs={OPERATION_STATUS} value={op.status} />
          {op.reservation_status && <StatusBadge defs={RESERVATION_STATUS} value={op.reservation_status} />}
          {op.reservation_number && <Badge tone="cinza">{op.reservation_number}</Badge>}
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {["confirmada", "em_rota", "no_local", "concluida"].map((s) => (
            <form key={s} action={setOperationStatus}>
              <input type="hidden" name="id" value={op.id} />
              <input type="hidden" name="status" value={s} />
              <SubmitButton
                variant={s === "concluida" ? "sucesso" : op.status === s ? "escuro" : "secundario"}
                className="w-full px-2 text-xs sm:text-sm"
              >
                {OPERATION_STATUS.find((x) => x.value === s)!.label}
              </SubmitButton>
            </form>
          ))}
        </div>

        <div className="mt-2 flex flex-wrap gap-2">
          <form action={setOperationStatus}>
            <input type="hidden" name="id" value={op.id} />
            <input type="hidden" name="status" value="reagendada" />
            <SubmitButton variant="secundario" className="px-3 py-2 text-xs">
              Reagendar
            </SubmitButton>
          </form>
          {user.role === "admin" && (
            <form action={cancelOperation}>
              <input type="hidden" name="id" value={op.id} />
              <SubmitButton variant="perigo" confirm="Cancelar esta operação?" className="px-3 py-2 text-xs">
                Cancelar Operação
              </SubmitButton>
            </form>
          )}
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          {maps && (
            <a
              href={maps}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 rounded-xl bg-marca-600 px-4 py-2.5 text-sm font-semibold text-white"
            >
              <Icon name="operacao" className="h-4 w-4" /> Abrir rota
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
          {op.phone && (
            <a
              href={`tel:${op.phone}`}
              className="inline-flex items-center gap-2 rounded-xl border border-nuvem-300 bg-white px-4 py-2.5 text-sm font-semibold"
            >
              Ligar
            </a>
          )}
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="Dados da Operação">
          <Row label="Cliente" value={op.customer ?? "-"} />
          <Row label="Telefone" value={phoneBR(op.phone) || "-"} />
          <Row label="Endereço" value={[op.address, op.district, op.city].filter(Boolean).join(", ") || "-"} />
          <Row label="Agendada para" value={dateTimeBR(op.scheduled_at)} />
          <Row label="Responsável" value={op.assignee || "-"} />
          <Row label="Veículo" value={op.vehicle_name || "-"} />
          <Row label="Concluída em" value={op.completed_at ? dateTimeBR(op.completed_at) : "-"} />
          {op.notes && <Row label="Observações" value={op.notes} />}
          {op.reservation_notes && <Row label="Obs. da reserva" value={op.reservation_notes} />}

          <form action={updateOperation} className="mt-3 grid grid-cols-2 gap-2">
            <input type="hidden" name="id" value={op.id} />
            <label className="block">
              <span className="rotulo">Reagendar para</span>
              <input
                name="scheduled_at"
                type="datetime-local"
                defaultValue={op.scheduled_at.slice(0, 16)}
                className="campo"
              />
            </label>
            <label className="block">
              <span className="rotulo">Responsável</span>
              <input name="assignee" defaultValue={op.assignee ?? ""} className="campo" />
              <span className="rotulo mt-2">Usuário responsável pelos avisos</span>
              <select name="assignee_id" defaultValue={op.assignee_id??""} className="campo"><option value="">Equipe pelas funções</option>{users.map(u=><option key={u.id} value={u.id}>{u.name}</option>)}</select>
            </label>
            <label className="block">
              <span className="rotulo">Veículo</span>
              <select name="vehicle_id" defaultValue={op.vehicle_id ?? ""} className="campo">
                <option value="">Sem veículo</option>
                {vehicles.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="rotulo">Observações</span>
              <input name="notes" defaultValue={op.notes ?? ""} className="campo" />
            </label>
            <div className="col-span-2">
              <SubmitButton variant="secundario" className="w-full">
                Salvar Alterações
              </SubmitButton>
            </div>
          </form>
        </Section>

        <Section title={`Itens (${itens.length})`}>
          {itens.length === 0 ? (
            <Empty>Operação sem itens vinculados.</Empty>
          ) : (
            <ul className="divide-y divide-nuvem-200">
              {itens.map((i) => (
                <li key={i.id} className="flex items-center justify-between py-2 text-sm">
                  <span className="font-semibold text-tinta-900">
                    {i.qty} x {i.product_name}
                  </span>
                  <span className="text-stone-500">{money(i.subtotal_cents)}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>

      <Section title={`Checklist de ${ehRetirada ? "retirada" : "entrega"}`}>
        <form action={saveChecklist} className="space-y-3">
          <input type="hidden" name="operation_id" value={op.id} />
          <div className="space-y-1.5">
            {itensChecklist.map((item) => (
              <label
                key={item}
                className="flex items-center gap-3 rounded-xl border border-nuvem-300 bg-white px-3 py-3 text-sm font-medium"
              >
                <input
                  type="checkbox"
                  name={`chk:${item}`}
                  defaultChecked={!!marcados[item]}
                  className="h-5 w-5 accent-[#051094]"
                />
                {item}
              </label>
            ))}
          </div>
          <label className="block">
            <span className="rotulo">Observações do checklist</span>
            <textarea name="notes" rows={3} defaultValue={checklist?.notes ?? ""} className="campo" />
          </label>
          <label className="block">
            <span className="rotulo">Anexar fotos</span>
            <ImageInput name="photos" multiple capture="environment" />
          </label>
          <SubmitButton className="w-full">Salvar checklist</SubmitButton>
        </form>

        {fotos.length > 0 && (
          <div className="mt-4 grid grid-cols-3 gap-2 sm:grid-cols-4">
            {fotos.map((f) => (
              <div key={f.id} className="relative">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={f.path} alt={f.caption ?? "Foto"} className="h-24 w-full rounded-xl object-cover" />
                <form action={deletePhoto} className="absolute right-1 top-1">
                  <input type="hidden" name="attachment_id" value={f.id} />
                  <input type="hidden" name="operation_id" value={op.id} />
                  <SubmitButton variant="perigo" confirm="Remover esta foto?" className="px-2 py-0.5 text-[0.65rem]">
                    x
                  </SubmitButton>
                </form>
              </div>
            ))}
          </div>
        )}
      </Section>

      {ehRetirada && op.reservation_id && (
        <Section title="Registrar dano">
          <Alerta tone="ambar">
            Danos com valor cobrado são descontados automaticamente da caução da reserva.
          </Alerta>
          <form action={reportDamage} className="mt-3 grid grid-cols-2 gap-2">
            <input type="hidden" name="operation_id" value={op.id} />
            <input type="hidden" name="reservation_id" value={op.reservation_id} />
            <label className="col-span-2 block">
              <span className="rotulo">Equipamento</span>
              <select name="product_id" className="campo">
                <option value="">Selecione…</option>
                {itens.map((i) => (
                  <option key={i.product_id} value={i.product_id}>
                    {i.product_name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="rotulo">Quantidade</span>
              <input name="qty" type="number" min={1} defaultValue={1} className="campo" />
            </label>
            <label className="block">
              <span className="rotulo">Tipo de dano</span>
              <input name="damage_type" className="campo" placeholder="Quebra, mancha, falta…" />
            </label>
            <label className="block">
              <span className="rotulo">Valor estimado (R$)</span>
              <input name="estimated" inputMode="decimal" className="campo" />
            </label>
            <label className="block">
              <span className="rotulo">Descontar da caução (R$)</span>
              <input name="charged" inputMode="decimal" className="campo" />
            </label>
            <label className="col-span-2 block">
              <span className="rotulo">Descrição</span>
              <textarea name="description" rows={2} className="campo" />
            </label>
            <label className="col-span-2 block">
              <span className="rotulo">Foto do dano</span>
              <ImageInput name="photo" capture="environment" />
            </label>
            <div className="col-span-2">
              <SubmitButton variant="perigo" className="w-full">
                Registrar dano
              </SubmitButton>
            </div>
          </form>

          {danos.length > 0 && (
            <ul className="mt-3 space-y-2">
              {danos.map((d) => {
                const pendente = d.resolution_status === "registrada" || d.resolution_status === "estornada" || d.resolution_status === "consertada";
                const ehKit = d.product_kind === "kit";
                return (
                  <li key={d.id} className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-800">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold">
                        {d.qty}x {d.product_name ?? "equipamento"} · {d.damage_type || "dano"}
                      </span>
                      <Badge tone={d.resolution_status === "baixada" ? "cinza" : d.resolution_status === "em_manutencao" ? "roxo" : d.resolution_status === "estornada" ? "ambar" : "vermelho"}>
                        {RESOLUTION_LABEL[d.resolution_status] ?? "Registrada"}
                      </Badge>
                      {d.charged_cents > 0 && <span>· descontado {money(d.charged_cents)}</span>}
                    </div>
                    {d.description && <span className="block text-xs opacity-80">{d.description}</span>}                    {pendente && (
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <form action={resolverDano} className="flex items-center gap-1">
                          <input type="hidden" name="damage_id" value={d.id} />
                          <input type="hidden" name="operation_id" value={op.id} />
                          <input type="hidden" name="reservation_id" value={op.reservation_id} />
                          <input type="hidden" name="action" value="baixa" />
                          <SubmitButton variant="perigo" confirm={ehKit ? `Baixar ${d.qty}x ${d.product_name ?? "kit"} do estoque? A baixa será expandida nos componentes físicos do kit.` : `Baixar definitivamente ${d.qty} un. de ${d.product_name ?? "do estoque"}? O disponível será reduzido.`} className="px-2 py-1 text-xs">
                            Baixar do estoque
                          </SubmitButton>
                        </form>
                        {!ehKit && (
                          <form action={resolverDano} className="flex items-center gap-1">
                            <input type="hidden" name="damage_id" value={d.id} />
                            <input type="hidden" name="operation_id" value={op.id} />
                            <input type="hidden" name="reservation_id" value={op.reservation_id} />
                            <input type="hidden" name="action" value="manutencao" />
                            <SubmitButton variant="secundario" className="px-2 py-1 text-xs">
                              Enviar p/ manutenção
                            </SubmitButton>
                          </form>
                        )}
                      </div>
                    )}
                    {ehKit && pendente && (
                      <p className="mt-1 text-xs opacity-80">
                        A baixa de um kit é expandida nos componentes físicos (ex.: 1 kit = 1 mesa + 4 cadeiras). Manutenção deve ser registrada no componente avulso.
                      </p>
                    )}

                    {d.resolution_status === "baixada" && (
                      <form action={estornarBaixaDano} className="mt-2 flex items-center gap-1">
                        <input type="hidden" name="damage_id" value={d.id} />
                        <input type="hidden" name="operation_id" value={op.id} />
                        <input type="hidden" name="reservation_id" value={op.reservation_id} />
                        <input name="motivo" placeholder="Motivo do estorno" className="rounded-lg border border-red-200 px-2 py-1 text-xs" />
                        <SubmitButton variant="secundario" className="px-2 py-1 text-xs">
                          Estornar baixa
                        </SubmitButton>
                      </form>
                    )}

                    {d.resolution_status === "em_manutencao" && (
                      <form action={consertarDano} className="mt-2">
                        <input type="hidden" name="damage_id" value={d.id} />
                        <input type="hidden" name="operation_id" value={op.id} />
                        <input type="hidden" name="reservation_id" value={op.reservation_id} />
                        <SubmitButton variant="sucesso" className="px-2 py-1 text-xs">
                          Consertado: devolver ao disponível
                        </SubmitButton>
                      </form>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Section>
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

      <p className="text-center">
        <Link href="/operacao" className="text-sm font-semibold text-marca-600">
          Voltar para Operação
        </Link>
      </p>
    </div>
  );
}
