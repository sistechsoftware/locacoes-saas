import Link from "next/link";
import { all, scalar } from "@/lib/db";
import { requireModule } from "@/lib/auth";
import { ehAdmin } from "@/lib/roles";
import { ACTIVE_STATUSES, PAYMENT_METHODS, PAYMENT_METHOD_LABEL } from "@/lib/domain";
import { dateBR, endOfMonth, money, startOfMonth, today } from "@/lib/format";
import { Alerta, Badge, Card, Empty, PageHeader, Section, Stat } from "@/components/ui";
import { Tabs } from "@/components/List";
import { listarEntries, totaisEntries } from "@/lib/receber";
import { novoGrupoTransferencia, SQL_NAO_TRANSFERENCIA, situacaoParcela } from "@/lib/financeiro";
import { listarTransferencias } from "@/lib/transferencias";
import { editarTransferenciaAction, excluirTransferenciaAction, transferirValor } from "./transferencias-actions";
import { receberParcela } from "./receber-actions";
import { payEntry } from "../compras/actions";
import { SubmitButton } from "@/components/SubmitButton";
import { addExpense, createPurpose, deleteExpense, finalidadesDisponiveis } from "./actions";
import { cancelarPagarManual, criarPagarManual } from "./pagar-actions";
import NovoPagarForm from "./NovoPagarForm";

export const dynamic = "force-dynamic";

const ACTIVE = ACTIVE_STATUSES.map((s) => `'${s}'`).join(",");

export default async function FinanceiroPage({
  searchParams,
}: {
  searchParams: Promise<{ aba?: string; de?: string; ate?: string; erro?: string; ok?: string; nova?: string }>;
}) {
  /* company_id vem SEMPRE do contexto autenticado (nunca fallback de tenant):
     cada leitura abaixo carrega a clausula de empresa na primeira posicao. */
  const ctx = await requireModule("financeiro");
  const user = ctx.user;
  const cid = ctx.companyId;
  const sp = await searchParams;
  const aba = sp.aba ?? "resumo";
  const de = sp.de || startOfMonth(today());
  const ate = sp.ate || endOfMonth(today());
  // o catalogo manda no que aparece; a finalidade recem-criada ja vem escolhida
  const finalidades = await finalidadesDisponiveis(sp.nova);

  /* leituras independentes: uma latencia so em vez de cinco */
  const [entradas, saidas, aReceber, caucaoRetida, reservas] = await Promise.all([
    all<any>(
    `SELECT p.*, r.number AS reservation_number, c.name AS customer_name, f.number AS freight_number
       FROM payments p
       LEFT JOIN reservations r ON r.id = p.reservation_id
       LEFT JOIN customers c ON c.id = r.customer_id
       LEFT JOIN freights f ON f.id = p.freight_id
      WHERE p.company_id = ? AND p.paid_at BETWEEN ? AND ? AND ${SQL_NAO_TRANSFERENCIA} ORDER BY p.paid_at DESC, p.id DESC`,
      [cid, de, ate],
    ),
    all<any>(
    `SELECT e.*, r.number AS reservation_number FROM expenses e
       LEFT JOIN reservations r ON r.id = e.reservation_id
      WHERE e.company_id = ? AND e.date BETWEEN ? AND ? ORDER BY e.date DESC, e.id DESC`,
      [cid, de, ate],
    ),
    all<any>(
    `SELECT r.id, r.number, r.event_date, r.total_cents, c.name AS customer_name,
            COALESCE((SELECT SUM(p.amount_cents) FROM payments p WHERE p.reservation_id = r.id),0) AS paid
       FROM reservations r JOIN customers c ON c.id = r.customer_id
      WHERE r.company_id = ?
        AND r.status IN (${ACTIVE})
        AND r.total_cents > COALESCE((SELECT SUM(p.amount_cents) FROM payments p WHERE p.reservation_id = r.id),0)
        ORDER BY r.event_date`,
      [cid],
    ),
    scalar<number>(
      `SELECT COALESCE(SUM(retained_cents),0) FROM deposits WHERE company_id = ? AND status IN ('retida_parcial','retida_integral')`,
      [cid],
    ),
    all<any>(
      `SELECT r.id, r.number, c.name AS customer_name FROM reservations r JOIN customers c ON c.id = r.customer_id
        WHERE r.company_id = ? AND r.status <> 'cancelada' ORDER BY r.id DESC LIMIT 100`,
      [cid],
    ),
  ]);

  // o cadastro manda no que aparece, mas uma conta desativada que ja tem
  // lancamento continua sendo mostrada pelo nome, sem virar "—"
  const nomesContas = new Map((await all<any>(`SELECT id, name FROM financial_accounts WHERE company_id = ?`, [cid])).map((c) => [c.id, c.name]));

  const [parcelasReceber, parcelasPagar, totReceber, totPagar, contasAtivas] = await Promise.all([
    listarEntries({ direction: "receber", situacao: "todas" }, cid),
    listarEntries({ direction: "pagar", situacao: "todas" }, cid),
    totaisEntries("receber", cid),
    totaisEntries("pagar", cid),
    all<any>(`SELECT id, name FROM financial_accounts WHERE company_id = ? AND active = 1 ORDER BY name`, [cid]),
  ]);

  /* Aba Transferências: lista, extrato por conta e token de idempotência.
     Carregado só quando a aba é aberta — os demais módulos não pagam o custo. */
  const transfers = aba === "transferencias" ? await listarTransferencias(cid, 200) : [];
  const contasTransferencia =
    aba === "transferencias"
      ? await all<any>(
          `SELECT id, name, kind, is_cash_account, active FROM financial_accounts WHERE company_id = ? ORDER BY active DESC, name COLLATE NOCASE`,
          [cid],
        )
      : [];
  const idsTransfer = contasTransferencia.map((c) => c.id);
  /* Extrato por conta da aba Transferências: linhas do periodo e saldo
     consolidado de cada conta — a MESMA fórmula da tela de Configurações ›
     Contas (inicial + entradas - saídas - despesas), para as duas telas
     nunca divergirem; as linhas listadas continuam sendo só payments, com os
     lados da transferência destacados. */
  const [movimentosContas, agregadosContas] =
    aba === "transferencias" && idsTransfer.length
      ? await Promise.all([
          all<any>(
            `SELECT account_id, amount_cents, paid_at, notes, transfer_group
               FROM payments
              WHERE company_id = ? AND account_id IN (${idsTransfer.map(() => "?").join(",")})
                AND paid_at BETWEEN ? AND ?
              ORDER BY paid_at DESC, id DESC`,
            [cid, ...idsTransfer, de, ate],
          ),
          all<any>(
            `SELECT a.id AS account_id, a.initial_balance_cents,
                    COALESCE(SUM(CASE WHEN p.amount_cents > 0 THEN p.amount_cents END),0) AS entradas,
                    COALESCE(SUM(CASE WHEN p.amount_cents < 0 THEN -p.amount_cents END),0) AS saidas,
                    COALESCE((SELECT SUM(e.amount_cents) FROM expenses e WHERE e.account_id = a.id),0) AS despesas
               FROM financial_accounts a
               LEFT JOIN payments p ON p.account_id = a.id
              WHERE a.company_id = ? AND a.id IN (${idsTransfer.map(() => "?").join(",")})
              GROUP BY a.id`,
            [cid, ...idsTransfer],
          ),
        ])
      : [[], []];
  const saldoFinalDe = new Map<number, number>(
    (agregadosContas as any[]).map((a) => [
      a.account_id,
      Number(a.initial_balance_cents) + Number(a.entradas) - Number(a.saidas) - Number(a.despesas),
    ]),
  );
  /* Token de idempotência do formulário de transferência: um envio = um token;
     reenviar o MESMO form é reconhecido no servidor e não duplica lançamento. */
  const grupoToken = novoGrupoTransferencia(cid);

  // dados do lancamento manual: fornecedores e finalidades seguem o que ja existe
  const fornecedores = await all<any>(`SELECT id, name FROM suppliers WHERE company_id = ? AND active = 1 ORDER BY name`, [cid]);

  const totalEntradas = entradas.reduce((s, e) => s + e.amount_cents, 0);
  const totalSaidas = saidas.reduce((s, e) => s + e.amount_cents, 0);
  const totalReceber = aReceber.reduce((s, r) => s + (r.total_cents - r.paid), 0);

  const porMetodo = PAYMENT_METHODS.map((m) => ({
    method: m,
    total: entradas.filter((e) => e.method === m).reduce((s, e) => s + e.amount_cents, 0),
  })).filter((x) => x.total > 0);

  // agrupa pelo que foi realmente lancado, e nao por uma lista fixa: assim uma
  // finalidade criada pelo administrador aparece no resumo como qualquer outra
  const porCategoria = [...saidas.reduce((mapa: Map<string, number>, e: any) => {
    const chave = String(e.category ?? "Outros");
    return mapa.set(chave, (mapa.get(chave) ?? 0) + e.amount_cents);
  }, new Map<string, number>())]
    .map(([category, total]) => ({ category, total }))
    .filter((x) => x.total > 0)
    .sort((a, b) => b.total - a.total);

  return (
    <div className="space-y-4">
      <PageHeader title="Financeiro" subtitle={`${dateBR(de)} até ${dateBR(ate)}`} />

      {sp.erro && <Alerta tone="vermelho" title="Não foi lançado">{sp.erro}</Alerta>}
      {sp.ok && <Alerta tone="verde" title="Pronto">{sp.ok}</Alerta>}

      <Card>
        <form className="pilha-filtros">
          <input type="hidden" name="aba" value={aba} />
          <label className="min-w-0 flex-1 basis-full sm:basis-40">
            <span className="rotulo">De</span>
            <input type="date" name="de" defaultValue={de} className="campo data-hora" />
          </label>
          <label className="min-w-0 flex-1 basis-full sm:basis-40">
            <span className="rotulo">Até</span>
            <input type="date" name="ate" defaultValue={ate} className="campo data-hora" />
          </label>
          <button className="w-full rounded-xl bg-marca-600 px-5 py-2.5 text-sm font-semibold text-white sm:w-auto">Filtrar</button>
        </form>
      </Card>

      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <Stat label="Entradas" value={money(totalEntradas)} tone="verde" />
        <Stat label="Saídas" value={money(totalSaidas)} tone="vermelho" />
        <Stat label="Resultado" value={money(totalEntradas - totalSaidas)} tone={totalEntradas - totalSaidas >= 0 ? "verde" : "vermelho"} />
        <Stat label="A receber (total)" value={money(totalReceber)} tone={totalReceber > 0 ? "vermelho" : "verde"} />
      </div>

      <Tabs
        items={[
          { value: "resumo", label: "Resumo" },
          { value: "entradas", label: "Entradas", count: entradas.length },
          { value: "saidas", label: "Saídas", count: saidas.length },
          { value: "transferencias", label: "Transferências", count: transfers.length },
          { value: "receber", label: "A receber", count: parcelasReceber.filter((p) => p.situacao !== "quitada").length },
          { value: "pagar", label: "A pagar", count: parcelasPagar.filter((p) => p.situacao !== "quitada").length },
        ]}
        current={aba}
        base={`/financeiro?de=${de}&ate=${ate}`}
      />

      {aba === "resumo" && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Section title="Entradas por forma de pagamento">
            {porMetodo.length === 0 ? (
              <Empty>Nenhuma entrada no período.</Empty>
            ) : (
              <ul className="divide-y divide-nuvem-200">
                {porMetodo.map((m) => (
                  <li key={m.method} className="flex items-center justify-between py-2 text-sm">
                    <span>{PAYMENT_METHOD_LABEL[m.method]}</span>
                    <span className="font-bold text-emerald-600">{money(m.total)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
          <Section title="Saídas por categoria">
            {porCategoria.length === 0 ? (
              <Empty>Nenhuma saída no período.</Empty>
            ) : (
              <ul className="divide-y divide-nuvem-200">
                {porCategoria.map((c) => (
                  <li key={c.category} className="flex items-center justify-between py-2 text-sm">
                    <span>{c.category}</span>
                    <span className="font-bold text-red-600">{money(c.total)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
          <Section title="Cauções">
            <p className="text-sm text-stone-600">
              Total retido por danos até hoje: <b className="text-tinta-900">{money(caucaoRetida)}</b>
            </p>
            <p className="mt-1 text-xs text-stone-500">
              A caução não entra no faturamento: é devolvida ao cliente, exceto na parte retida.
            </p>
          </Section>
        </div>
      )}

      {aba === "entradas" && (
        <Section title={`Entradas (${entradas.length})`}>
          {entradas.length === 0 ? (
            <Empty>Nenhuma entrada no período.</Empty>
          ) : (
            <ul className="divide-y divide-nuvem-200">
              {entradas.map((e) => (
                <li key={e.id} className="flex items-center justify-between gap-3 py-2.5">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-tinta-900">
                      {e.customer_name ?? e.notes ?? "Entrada"}
                    </p>
                    <p className="text-xs text-stone-500">
                      {dateBR(e.paid_at)} · {PAYMENT_METHOD_LABEL[e.method] ?? e.method}
                      {e.reservation_number ? ` · ` : ""}
                      {e.reservation_number && (
                        <Link href={`/reservas/${e.reservation_id}`} className="text-marca-600">
                          {e.reservation_number}
                        </Link>
                      )}
                      {e.freight_number ? ` · ${e.freight_number}` : ""}
                      {e.account_id ? ` · ${nomesContas.get(e.account_id) ?? "conta removida"}` : " · sem conta"}
                    </p>
                  </div>
                  <span className="shrink-0 font-bold text-emerald-600">{money(e.amount_cents)}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}

      {aba === "saidas" && (
        <div className="space-y-4">
          <Section title="Lançar Saída">
            <form action={addExpense} className="grid grid-cols-2 gap-2">
              {/* o periodo viaja junto para o lancamento voltar para a mesma tela */}
              <input type="hidden" name="aba" value="saidas" />
              <input type="hidden" name="de" value={de} />
              <input type="hidden" name="ate" value={ate} />
              <input name="date" type="date" defaultValue={today()} className="campo" />
              <select name="category" defaultValue={sp.nova ?? finalidades[0]} className="campo">
                {finalidades.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
              <input name="description" placeholder="Descrição" className="campo col-span-2" />
              <input name="amount" placeholder="Valor (R$)" inputMode="decimal" className="campo" required />
              <select name="method" className="campo">
                {PAYMENT_METHODS.map((m) => (
                  <option key={m} value={m}>
                    {PAYMENT_METHOD_LABEL[m]}
                  </option>
                ))}
              </select>
              <select name="reservation_id" className="campo col-span-2">
                <option value="">Sem reserva vinculada</option>
                {reservas.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.number} - {r.customer_name}
                  </option>
                ))}
              </select>
              <label className="col-span-2 block">
                <span className="rotulo">Conta Corrente</span>
                <select name="account_id" defaultValue={contasAtivas.length === 1 ? String(contasAtivas[0].id) : ""} className="campo">
                  <option value="">Sem conta (dinheiro fora das contas cadastradas)</option>
                  {contasAtivas.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
              <div className="col-span-2">
                <SubmitButton className="w-full">Lançar Saída</SubmitButton>
              </div>
            </form>

            {ehAdmin(user.role) && (
              <details className="mt-3">
                <summary className="cursor-pointer text-sm font-semibold text-marca-600">
                  + Nova Finalidade
                </summary>
                {/* form separado: um formulario dentro do outro seria HTML invalido */}
                <form action={createPurpose} className="mt-2 pilha-filtros">
                  <input type="hidden" name="aba" value="saidas" />
                  <input type="hidden" name="de" value={de} />
                  <input type="hidden" name="ate" value={ate} />
                  <input
                    name="name"
                    placeholder="Ex.: Manutenção do veículo"
                    maxLength={60}
                    required
                    className="campo min-w-0 flex-1 basis-48"
                  />
                  <SubmitButton variant="secundario">Salvar Finalidade</SubmitButton>
                </form>
                <p className="mt-1 text-xs text-stone-500">
                  A nova finalidade fica disponível na hora e já vem selecionada. Para renomear ou desativar, use
                  Configurações.
                </p>
              </details>
            )}
          </Section>

          <Section title={`Saidas (${saidas.length})`}>
            {saidas.length === 0 ? (
              <Empty>Nenhuma saída no período.</Empty>
            ) : (
              <ul className="divide-y divide-nuvem-200">
                {saidas.map((e) => (
                  <li key={e.id} className="flex items-center justify-between gap-3 py-2.5">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-tinta-900">
                        {e.category}
                        {e.description ? ` · ${e.description}` : ""}
                      </p>
                      <p className="text-xs text-stone-500">
                        {dateBR(e.date)} · {PAYMENT_METHOD_LABEL[e.method] ?? e.method}
                        {e.reservation_number ? ` · ${e.reservation_number}` : ""}
                        {e.account_id ? ` · ${nomesContas.get(e.account_id) ?? "conta removida"}` : " · sem conta"}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <span className="font-bold text-red-600">{money(e.amount_cents)}</span>
                      {ehAdmin(user.role) && (
                        <form action={deleteExpense}>
                          <input type="hidden" name="id" value={e.id} />
                          <SubmitButton variant="perigo" confirm="Remover esta saída?" className="px-2 py-1 text-xs">
                            x
                          </SubmitButton>
                        </form>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>
      )}

      {aba === "transferencias" && (
        <div className="space-y-4">
          <Section title="Transferir entre contas">
            <p className="mb-3 text-sm text-stone-600">
              Movimenta dinheiro de uma conta para outra. <b>Não é receita e não é despesa:</b> o total em caixa fica
              exatamente igual — só muda onde o dinheiro está.
            </p>
            {contasTransferencia.filter((c) => c.active).length < 2 ? (
              <Empty>Cadastre ao menos duas contas ativas para transferir. O cadastro fica em Configurações › Contas.</Empty>
            ) : (
              <form action={transferirValor} className="grid grid-cols-2 gap-2">
                <input type="hidden" name="aba" value="transferencias" />
                <input type="hidden" name="de" value={de} />
                <input type="hidden" name="ate" value={ate} />
                {/* token de idempotência: reenviar este MESMO form não duplica */}
                <input type="hidden" name="grupo" value={grupoToken} />
                <label className="block">
                  <span className="rotulo">Conta de origem *</span>
                  <select name="origem_id" className="campo" required defaultValue="">
                    <option value="" disabled>
                      Selecionar conta…
                    </option>
                    {contasTransferencia.filter((c) => c.active).map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                        {c.is_cash_account ? " (dinheiro em espécie)" : ""}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="rotulo">Conta de destino *</span>
                  <select name="destino_id" className="campo" required defaultValue="">
                    <option value="" disabled>
                      Selecionar conta…
                    </option>
                    {contasTransferencia.filter((c) => c.active).map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                        {c.is_cash_account ? " (dinheiro em espécie)" : ""}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="rotulo">Valor (R$) *</span>
                  <input name="amount" inputMode="decimal" placeholder="0,00" required className="campo" />
                </label>
                <label className="block">
                  <span className="rotulo">Data *</span>
                  <input name="date" type="date" defaultValue={today()} className="campo" required />
                </label>
                <label className="col-span-2 block">
                  <span className="rotulo">Observação</span>
                  <input name="observacao" maxLength={120} placeholder="Opcional — ex.: saque para o evento" className="campo" />
                </label>
                <div className="col-span-2">
                  <SubmitButton className="w-full">Transferir valor</SubmitButton>
                </div>
              </form>
            )}
          </Section>

          <Section title={`Transferências realizadas (${transfers.length})`}>
            {transfers.length === 0 ? (
              <Empty>Nenhuma transferência entre contas.</Empty>
            ) : (
              <ul className="divide-y divide-nuvem-200">
                {transfers.map((t) => (
                  <li key={t.grupo} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-tinta-900">
                        <Badge tone="azul">Transferência</Badge>
                        <span>
                          {t.origem_nome} → {t.destino_nome}
                        </span>
                      </p>
                      <p className="text-xs text-stone-500">
                        {dateBR(t.data)} · transferência interna · não entra em receitas nem despesas
                        {t.observacao ? ` · ${t.observacao}` : ""}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {ehAdmin(user.role) ? (
                        <details className="relative">
                          <summary className="cursor-pointer list-none rounded-xl border border-nuvem-300 px-3 py-1.5 text-xs font-semibold text-stone-600">
                            Editar
                          </summary>
                          <div className="absolute right-0 z-20 mt-2 w-72 rounded-xl border border-nuvem-300 bg-white p-3 shadow-lg">
                            <form action={editarTransferenciaAction} className="space-y-2">
                              <input type="hidden" name="grupo" value={t.grupo} />
                              <input type="hidden" name="aba" value="transferencias" />
                              <input type="hidden" name="de" value={de} />
                              <input type="hidden" name="ate" value={ate} />
                              <select name="origem_id" defaultValue={String(t.origem_id)} className="campo" aria-label="Conta de origem">
                                {contasTransferencia.map((c) => (
                                  <option key={c.id} value={c.id}>
                                    {c.name}
                                  </option>
                                ))}
                              </select>
                              <select name="destino_id" defaultValue={String(t.destino_id)} className="campo" aria-label="Conta de destino">
                                {contasTransferencia.map((c) => (
                                  <option key={c.id} value={c.id}>
                                    {c.name}
                                  </option>
                                ))}
                              </select>
                              <input
                                name="amount"
                                defaultValue={(t.valor_cents / 100).toFixed(2)}
                                inputMode="decimal"
                                className="campo"
                                aria-label="Valor"
                              />
                              <input name="date" type="date" defaultValue={String(t.data).slice(0, 10)} className="campo" aria-label="Data" />
                              <input
                                name="observacao"
                                defaultValue={t.observacao}
                                maxLength={120}
                                className="campo"
                                aria-label="Observação"
                              />
                              <SubmitButton className="w-full">Salvar alteração</SubmitButton>
                            </form>
                          </div>
                        </details>
                      ) : (
                        <span className="rounded-xl border border-nuvem-200 px-3 py-1.5 text-xs text-stone-400">
                          Somente administradores editam
                        </span>
                      )}
                      {ehAdmin(user.role) && (
                        <form action={excluirTransferenciaAction}>
                          <input type="hidden" name="grupo" value={t.grupo} />
                          <input type="hidden" name="aba" value="transferencias" />
                          <input type="hidden" name="de" value={de} />
                          <input type="hidden" name="ate" value={ate} />
                          <SubmitButton
                            variant="perigo"
                            confirm={`Excluir a transferência de ${money(t.valor_cents)}? Os dois lados voltam: ${t.origem_nome} recebe de volta e ${t.destino_nome} perde o valor.`}
                            className="px-2 py-1 text-xs"
                          >
                            Excluir
                          </SubmitButton>
                        </form>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          {idsTransfer.length > 0 && <ExtratoContas contas={contasTransferencia} movimentos={movimentosContas} saldoDe={saldoFinalDe} />}
        </div>
      )}

      {(aba === "receber" || aba === "pagar") && (
        <ListaParcelas
          direcao={aba}
          parcelas={aba === "receber" ? parcelasReceber : parcelasPagar}
          totais={aba === "receber" ? totReceber : totPagar}
          contas={contasAtivas}
          fornecedores={fornecedores}
          finalidades={finalidades}
          hoje={today()}
        />
      )}
    </div>
  );
}

/**
 * Extrato de cada conta, com as transferencias destacadas.
 *
 * Os lados entram como entradas/saidas normais (e e assim que o saldo fecha),
 * mas a descricao gravada na propria linha ja diz de onde/para onde o dinheiro
 * foi — e o selo azul separa visualmente transferencia de receita e despesa.
 */
function ExtratoContas({
  contas,
  movimentos,
  saldoDe,
}: {
  contas: any[];
  movimentos: any[];
  saldoDe: Map<number, number>;
}) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {contas.map((c) => (
        <ExtratoConta key={c.id} conta={c} movimentos={movimentos} saldo={saldoDe.get(c.id) ?? 0} />
      ))}
    </div>
  );
}

function ExtratoConta({
  conta,
  movimentos,
  saldo,
}: {
  conta: any;
  movimentos: any[];
  saldo: number;
}) {
  const linhas = movimentos
    .filter((m) => m.account_id === conta.id)
    .map((m) => ({ ...m, transfer: m.transfer_group != null }));
  const entradasPeriodo = linhas.filter((l) => l.amount_cents > 0).reduce((s, l) => s + l.amount_cents, 0);
  const saidasPeriodo = linhas.filter((l) => l.amount_cents < 0).reduce((s, l) => s - l.amount_cents, 0);
  return (
    <Section title={`${conta.name}${conta.is_cash_account ? " (dinheiro em espécie)" : ""}${conta.active ? "" : " (inativa)"}`}>
      <p className="mb-2 text-xs text-stone-500">
        Saldo da conta (todas as datas): <b className="text-tinta-900">{money(saldo)}</b> · entradas do período{" "}
        {money(entradasPeriodo)} · saídas {money(saidasPeriodo)}
      </p>
      {linhas.length === 0 ? (
        <Empty>Nenhuma movimentação no período.</Empty>
      ) : (
        <ul className="divide-y divide-nuvem-200">
          {linhas.map((l, i) => (
            <li key={i} className="flex items-center justify-between gap-3 py-2">
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-1.5 text-sm font-semibold text-tinta-900">
                  {l.transfer ? <Badge tone="azul">Transferência</Badge> : null}
                  <span className="truncate">{l.notes || (l.amount_cents > 0 ? "Entrada" : "Saída")}</span>
                </p>
                <p className="text-xs text-stone-500">{dateBR(l.paid_at)}</p>
              </div>
              <span className={`shrink-0 text-sm font-bold ${l.amount_cents < 0 ? "text-amber-600" : "text-emerald-600"}`}>
                {l.amount_cents < 0 ? "−" : "+"}
                {money(Math.abs(l.amount_cents))}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

const TOM: Record<string, "verde" | "ambar" | "vermelho" | "cinza"> = {
  quitada: "verde",
  parcial: "ambar",
  vencida: "vermelho",
  aberta: "cinza",
  cancelada: "cinza",
};

/**
 * Parcelas previstas de uma direcao.
 *
 * Previsto e realizado ficam lado a lado de proposito: o total contratado nao
 * e dinheiro em caixa, e a tela precisa deixar isso obvio.
 *
 * Na direcao 'pagar' o usuario tambem pode lancar uma conta manualmente, pelo
 * mesmo livro financial_entries que as parcelas de compra usam. O formulario
 * fica fechado por padrao, atras do botao "+ Novo Contas a Pagar".
 */
function ListaParcelas({
  direcao,
  parcelas,
  totais,
  contas,
  fornecedores,
  finalidades,
  hoje,
}: {
  direcao: "receber" | "pagar";
  parcelas: any[];
  totais: { previsto: number; liquidado: number; saldo: number; atrasado: number };
  contas: { id: number; name: string }[];
  fornecedores: { id: number; name: string }[];
  finalidades: string[];
  hoje: string;
}) {
  const receber = direcao === "receber";
  const abertas = parcelas.filter((p) => p.situacao !== "quitada" && p.situacao !== "cancelada");
  const acao = receber ? receberParcela : payEntry;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <Stat label={receber ? "Contratado" : "Previsto"} value={money(totais.previsto)} />
        <Stat label={receber ? "Recebido" : "Pago"} value={money(totais.liquidado)} tone="verde" />
        <Stat
          label={receber ? "A receber" : "A pagar"}
          value={money(totais.saldo)}
          tone={totais.saldo > 0 ? "vermelho" : "verde"}
        />
        <Stat label="Vencido" value={money(totais.atrasado)} tone={totais.atrasado > 0 ? "vermelho" : undefined} />
      </div>

      {!receber && (
        <details className="cartao p-4">
          <summary className="cursor-pointer text-sm font-bold text-marca-600 select-none">
            + Novo Contas a Pagar
          </summary>
          <div className="mt-3">
            <NovoPagarForm action={criarPagarManual} finalidades={finalidades} fornecedores={fornecedores} contas={contas} hoje={hoje} />
          </div>
        </details>
      )}

      <Section title={`${receber ? "Contas a receber" : "Contas a pagar"} (${abertas.length} em aberto)`}>
        {abertas.length === 0 ? (
          <Empty>
            {receber
              ? "Nenhuma parcela a receber. Gere o parcelamento na tela da reserva ou do frete."
              : "Nenhuma parcela a pagar. As parcelas aparecem aqui quando você registra uma compra ou lança uma conta manualmente no botão acima."}
          </Empty>
        ) : (
          <ul className="space-y-2">
            {abertas.map((p) => (
              <li key={p.id} id={`parcela-${p.id}`} className="rounded-xl border border-nuvem-300 bg-white p-3 scroll-mt-20">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-bold text-tinta-900">{p.description}</span>
                    <span className="block text-xs text-stone-500">
                      {p.number} · {p.purchase_date ? `compra em ${dateBR(p.purchase_date)} · ` : ""}vence em {dateBR(p.due_date)}
                      {p.installments_total > 1 ? ` · ${p.installment}/${p.installments_total}` : ""}
                      {p.customer_name ? ` · ${p.customer_name}` : ""}
                      {p.supplier_name ? ` · ${p.supplier_name}` : ""}
                    </span>
                    {p.liquidado_cents > 0 && (
                      <span className="block text-xs text-stone-500">
                        {receber ? "Recebido" : "Pago"} {money(p.liquidado_cents)}, faltam {money(p.saldo_cents)}
                      </span>
                    )}
                  </span>
                  <span className="shrink-0 text-right">
                    <span className="block text-sm font-bold">{money(p.amount_cents)}</span>
                    <Badge tone={TOM[p.situacao]}>{p.situacao}</Badge>
                  </span>
                </div>

                <form action={acao} className="mt-2 grid grid-cols-2 gap-2">
                  <input type="hidden" name="entry_id" value={p.id} />
                  <input
                    name="amount"
                    defaultValue={(p.saldo_cents / 100).toFixed(2)}
                    inputMode="decimal"
                    className="campo"
                    aria-label="Valor"
                  />
                  <input name="paid_at" type="date" defaultValue={today()} className="campo" />
                  <select name="method" className="campo">
                    {PAYMENT_METHODS.map((m) => (
                      <option key={m} value={m}>
                        {PAYMENT_METHOD_LABEL[m]}
                      </option>
                    ))}
                  </select>
                  <select name="account_id" defaultValue={p.account_id ?? ""} className="campo">
                    <option value="">Conta…</option>
                    {contas.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                  <div className={p.origin === "despesa" ? "grid grid-cols-[1fr_auto] gap-2 col-span-2" : "col-span-2"}>
                    <SubmitButton className="w-full">
                      {receber ? "Registrar recebimento" : "Registrar pagamento"}
                    </SubmitButton>
                    {!receber && p.origin === "despesa" && (
                      <SubmitButton variant="perigo" confirm="Cancelar esta conta a pagar?" value={String(p.id)} formAction={cancelarPagarManual} className="px-3">
                        Cancelar
                      </SubmitButton>
                    )}
                  </div>
                </form>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-xs text-stone-500">
          O caixa registra apenas o valor efetivamente movimentado, nunca o total contratado de uma vez.
        </p>
      </Section>
    </div>
  );
}
