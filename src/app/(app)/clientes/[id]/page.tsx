import Link from "next/link";
import { notFound } from "next/navigation";
import { all } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { getCustomer } from "@/lib/queries";
import { logsFor } from "@/lib/audit";
import { RESERVATION_STATUS, QUOTE_STATUS } from "@/lib/domain";
import { dateBR, docBR, mapsLink, money, phoneBR, utcParaLocal, waLink } from "@/lib/format";
import { Alerta, Badge, Card, Empty, LinkButton, PageHeader, Row, Section, StatusBadge, Stat } from "@/components/ui";
import { ListRow } from "@/components/List";
import { Icon } from "@/components/Icons";
import { FidelidadeCliente } from "@/components/FidelidadeCliente";
import { DocumentosCliente } from "@/components/DocumentosCliente";
import { documentosDoCliente } from "@/lib/assinatura-db";
import { painelDoCliente, historicoDe, mensagensDoCliente } from "@/lib/fidelidade-db";
import { today } from "@/lib/format";
import { deleteCustomer, toggleCustomer } from "../actions";
import { gerarAcessoPortal } from "../portal-actions";
import { acessoPortalDe } from "@/lib/portal-auth";
import { SubmitButton } from "@/components/SubmitButton";

export const dynamic = "force-dynamic";

export default async function ClientePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ aviso?: string; portal_link?: string; portal_wa?: string }>;
}) {
  const user = await requireUser();
  const { id } = await params;
  const { aviso, portal_link, portal_wa } = await searchParams;
  const c = await getCustomer(Number(id));
  if (!c) notFound();

  /*
   * Leitura do painel do cliente em paralelo.
   *
   * Sao sete leituras independentes entre si: antes, cada uma esperava a
   * anterior e o tempo da tela era a SOMA das consultas. Juntas, custam a
   * consulta mais lenta do grupo (uma latencia de rede so).
   */
  const [acessoPortal, reservas, orcamentos, pagamentos, historico, fidelidade, fidelidadeHistorico, fidelidadeMensagens, documentos] = await Promise.all([
    acessoPortalDe(c.id),
    all<any>(
      `SELECT r.*, (SELECT COALESCE(SUM(amount_cents),0) FROM payments p WHERE p.reservation_id = r.id) AS paid
       FROM reservations r WHERE r.customer_id = ? ORDER BY r.event_date DESC LIMIT 50`,
      [c.id],
    ),
    all<any>(`SELECT * FROM quotes WHERE customer_id = ? ORDER BY id DESC LIMIT 20`, [c.id]),
    all<any>(
      `SELECT p.*, r.number FROM payments p LEFT JOIN reservations r ON r.id = p.reservation_id
      WHERE r.customer_id = ? ORDER BY p.paid_at DESC LIMIT 20`,
      [c.id],
    ),
    logsFor("cliente", c.id),
    painelDoCliente(c.id),
    historicoDe(c.id),
    mensagensDoCliente(c.id),
    documentosDoCliente(c.id),
  ]);
  historico.length = Math.min(historico.length, 10);

  const wa = waLink(c.whatsapp || c.phone, `Olá, ${c.name.split(" ")[0]}! Aqui é da Lima's Locações.`);
  const maps = mapsLink(c.address, c.district, c.city);

  return (
    <div className="space-y-4">
      <PageHeader
        title={c.name}
        subtitle={[docBR(c.doc), phoneBR(c.phone)].filter(Boolean).join(" · ") || "Cliente"}
        action={
          <>
            <LinkButton href={`/reservas/nova?cliente=${c.id}`} variant="primario">
              + Nova Reserva
            </LinkButton>
            <LinkButton href={`/orcamentos/novo?cliente=${c.id}`}>+ Orçamento</LinkButton>
            <LinkButton href={`/clientes/${c.id}/editar`}>Editar</LinkButton>
          </>
        }
      />

      {aviso === "inativado" && (
        <Alerta tone="ambar" title="Cliente inativado">
          O cliente possui histórico de locações, por isso foi inativado em vez de excluído.
        </Alerta>
      )}
      {!c.active && <Alerta tone="ambar">Este cliente está inativo.</Alerta>}

      {portal_link && (
        <div className="cartao border-emerald-300 bg-emerald-50 p-4">
          <p className="text-sm font-bold text-emerald-800">🔗 Link de acesso ao Portal do Cliente gerado</p>
          <p className="mt-1 text-xs text-emerald-800">
            Válido por 7 dias. Envie para o cliente pelo WhatsApp — após o primeiro uso, o link expira.
          </p>
          <p className="mt-2 break-all rounded-xl border border-emerald-300 bg-white px-3 py-2 text-xs text-tinta-800">
            {portal_link}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {portal_wa && (
              <a
                href={`${portal_wa}?text=${encodeURIComponent(`Olá! Este é seu acesso ao Portal do Cliente ${"Lima's"}: ${portal_link}`)}`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white"
              >
                <Icon name="whatsapp" className="h-4 w-4" /> Enviar no WhatsApp
              </a>
            )}
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <Stat label="Locações" value={c.locacoes} />
        <Stat label="Total gasto" value={money(c.total_cents)} />
        <Stat label="Saldo em aberto" value={money(c.saldo_cents)} tone={c.saldo_cents > 0 ? "vermelho" : "verde"} />
        <Stat label="Canceladas" value={c.canceladas} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="Dados do cliente">
          <Row label="CPF / CNPJ" value={docBR(c.doc) || "-"} />
          <Row label="Telefone" value={phoneBR(c.phone) || "-"} />
          <Row label="WhatsApp" value={phoneBR(c.whatsapp) || "-"} />
          <Row label="E-mail" value={c.email || "-"} />
          <Row label="Endereço" value={c.address || "-"} />
          <Row label="Bairro" value={c.district || "-"} />
          <Row label="Cidade" value={c.city || "-"} />
          <Row label="CEP" value={c.zip || "-"} />
          <Row label="Última locação" value={c.ultima ? dateBR(c.ultima) : "-"} />
          <Row label="Próxima locação" value={c.proxima ? dateBR(c.proxima) : "-"} />
          {c.notes && <Row label="Observações" value={c.notes} />}

          <div className="mt-3 flex flex-wrap gap-2">
            {wa && (
              <a
                href={wa}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white"
              >
                <Icon name="whatsapp" className="h-4 w-4" /> Enviar WhatsApp
              </a>
            )}
            {maps && (
              <a
                href={maps}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-2 rounded-xl border border-nuvem-300 bg-white px-4 py-2.5 text-sm font-semibold"
              >
                <Icon name="operacao" className="h-4 w-4" /> Ver rota
              </a>
            )}
            {c.phone && (
              <a
                href={`tel:${c.phone}`}
                className="inline-flex items-center gap-2 rounded-xl border border-nuvem-300 bg-white px-4 py-2.5 text-sm font-semibold"
              >
                Ligar
              </a>
            )}
          </div>
        </Section>

        <FidelidadeCliente
          regra={fidelidade.regra}
          progresso={fidelidade.progresso}
          recompensas={fidelidade.recompensas}
          mensagens={fidelidadeMensagens}
          historico={fidelidadeHistorico}
          telefone={c.whatsapp || c.phone}
          hoje={today()}
        />

        <DocumentosCliente customerId={c.id} documentos={documentos} admin={user.role === "admin"} />

        <Section title={`Reservas (${reservas.length})`}>
          {reservas.length === 0 ? (
            <Empty>Nenhuma reserva para este cliente.</Empty>
          ) : (
            <div className="space-y-2">
              {reservas.map((r) => (
                <ListRow
                  key={r.id}
                  href={`/reservas/${r.id}`}
                  badges={<StatusBadge defs={RESERVATION_STATUS} value={r.status} />}
                  title={`${r.number} - ${dateBR(r.event_date)}`}
                  subtitle={[r.address, r.district].filter(Boolean).join(", ")}
                  right={
                    <>
                      <p className="text-sm font-bold">{money(r.total_cents)}</p>
                      {r.total_cents - r.paid > 0 && r.status !== "cancelada" && (
                        <p className="text-xs text-red-600">saldo {money(r.total_cents - r.paid)}</p>
                      )}
                    </>
                  }
                />
              ))}
            </div>
          )}
        </Section>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title={`Orçamentos (${orcamentos.length})`}>
          {orcamentos.length === 0 ? (
            <Empty>Nenhum orçamento.</Empty>
          ) : (
            <div className="space-y-2">
              {orcamentos.map((q) => (
                <ListRow
                  key={q.id}
                  href={`/orcamentos/${q.id}`}
                  badges={<StatusBadge defs={QUOTE_STATUS} value={q.status} />}
                  title={`${q.number} - ${dateBR(q.event_date)}`}
                  right={<p className="text-sm font-bold">{money(q.total_cents)}</p>}
                />
              ))}
            </div>
          )}
        </Section>

        <Section title="Pagamentos recentes">
          {pagamentos.length === 0 ? (
            <Empty>Nenhum pagamento registrado.</Empty>
          ) : (
            <ul className="divide-y divide-nuvem-200">
              {pagamentos.map((p) => (
                <li key={p.id} className="flex items-center justify-between py-2 text-sm">
                  <span>
                    <span className="font-semibold">{dateBR(p.paid_at)}</span>
                    <span className="ml-2 text-stone-500">{p.number}</span>
                  </span>
                  <span className="font-bold text-emerald-600">{money(p.amount_cents)}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>

      {historico.length > 0 && (
        <Section title="Histórico de alterações">
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

      <Card className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-tinta-900">Portal do Cliente</p>
          <p className="text-xs text-stone-500">
            {acessoPortal?.portal_password_hash
              ? "Cliente com acesso ativo ao portal (CPF + senha)."
              : acessoPortal?.portal_setup_token_hash
                ? "Convite gerado e aguardando o cliente criar a senha."
                : "Cliente sem acesso ao portal. Gere um convite para liberar."}
          </p>
        </div>
        <form action={gerarAcessoPortal}>
          <input type="hidden" name="id" value={c.id} />
          <SubmitButton variant="secundario">
            {acessoPortal?.portal_password_hash ? "Redefinir acesso" : "Gerar convite de acesso"}
          </SubmitButton>
        </form>
      </Card>

      {user.role === "admin" && (
        <Card className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-tinta-900">Área do administrador</p>
            <p className="text-xs text-stone-500">
              Clientes com histórico são inativados em vez de excluídos, para preservar as reservas.
            </p>
          </div>
          <div className="flex gap-2">
            <form action={toggleCustomer}>
              <input type="hidden" name="id" value={c.id} />
              <SubmitButton variant="secundario">{c.active ? "Inativar" : "Reativar"}</SubmitButton>
            </form>
            <form action={deleteCustomer}>
              <input type="hidden" name="id" value={c.id} />
              <SubmitButton variant="perigo" confirm={`Excluir o cliente ${c.name}? Esta ação não pode ser desfeita.`}>
                Excluir
              </SubmitButton>
            </form>
          </div>
        </Card>
      )}

      <p className="text-center">
        <Link href="/clientes" className="text-sm font-semibold text-marca-600">
          Voltar para Clientes
        </Link>
      </p>
    </div>
  );
}
