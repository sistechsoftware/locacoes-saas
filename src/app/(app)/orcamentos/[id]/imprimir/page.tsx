import { notFound } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import { one } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { getSettings } from "@/lib/settings";
import { quoteItems } from "@/lib/reservations";
import { QUOTE_STATUS, statusLabel } from "@/lib/domain";
import { dateBR, dateUtcBR, docBR, money, phoneBR, timeBR } from "@/lib/format";
import PrintButton from "@/app/(app)/contratos/[id]/PrintButton";

export const dynamic = "force-dynamic";

/** Consulta unica usada tanto pelo titulo quanto pelo documento. */
async function carregar(id: number) {
  return await one<any>(
    `SELECT qt.*, c.name AS customer_name, c.doc AS customer_doc, c.phone AS customer_phone,
            c.whatsapp AS customer_whatsapp, c.email AS customer_email, c.address AS customer_address,
            c.district AS customer_district, c.city AS customer_city
       FROM quotes qt JOIN customers c ON c.id = qt.customer_id WHERE qt.id = ?`,
    [id],
  );
}

/**
 * O navegador usa o titulo da pagina como nome do arquivo ao salvar em PDF,
 * entao ele ja sai como Orcamento-ORC-001-Joao-Silva.
 */
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const q = await carregar(Number(id));
  if (!q) return { title: "Orçamento" };
  return { title: `Orçamento-${sanitizar(q.number)}-${sanitizar(q.customer_name)}` };
}

/** Tira acentos e simbolos que atrapalham o nome do arquivo. */
function sanitizar(texto: string | null | undefined): string {
  return (texto ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export default async function OrcamentoImprimirPage({ params }: { params: Promise<{ id: string }> }) {
  // mesma permissao da tela do orcamento: sem sessao nao ha documento
  await requireUser();
  const { id } = await params;
  const q = await carregar(Number(id));
  if (!q) notFound();

  const [itens, s] = await Promise.all([quoteItems(q.id), getSettings()]);

  const enderecoEmpresa = [s.company_address, s.company_city].filter(Boolean).join(" - ");
  const enderecoCliente = [q.customer_address, q.customer_district, q.customer_city].filter(Boolean).join(", ");
  const enderecoEvento = [q.address, q.district, q.city].filter(Boolean).join(", ");
  const contatoEmpresa = [phoneBR(s.company_phone), s.company_email].filter(Boolean).join(" - ");

  // linhas de servico so aparecem quando tem valor
  const servicos = [
    { rotulo: "Frete (entrega e retirada)", valor: q.freight_cents },
    { rotulo: "Montagem", valor: q.assembly_cents },
    { rotulo: "Desmontagem", valor: q.disassembly_cents },
    { rotulo: "Outros serviços", valor: q.other_cents },
  ].filter((l) => l.valor > 0);

  const temDesconto = q.discount_cents > 0;
  const subtotal = q.items_cents + servicos.reduce((soma, l) => soma + l.valor, 0);

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="nao-imprimir flex flex-wrap items-center justify-between gap-2">
        <Link href={`/orcamentos/${q.id}`} className="text-sm font-semibold text-marca-600">
          Voltar ao Orçamento
        </Link>
        <PrintButton />
      </div>

      <article className="cartao imprimivel bg-white p-6 text-tinta-900 sm:p-10">
        {/* cabecalho */}
        <header className="flex flex-wrap items-start justify-between gap-4 border-b-2 border-marca-600 pb-4">
          <div className="flex items-center gap-3">
            {s.company_logo ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={s.company_logo} alt="" className="h-16 w-16 rounded-xl object-contain" />
            ) : null}
            <div>
              <p className="text-lg font-black leading-tight text-marca-600">{s.company_name}</p>
              {s.company_doc && <p className="text-xs text-stone-600">CNPJ/CPF: {docBR(s.company_doc)}</p>}
              {contatoEmpresa && <p className="text-xs text-stone-600">{contatoEmpresa}</p>}
              {enderecoEmpresa && <p className="text-xs text-stone-600">{enderecoEmpresa}</p>}
            </div>
          </div>
          <div className="text-right">
            <p className="text-xs font-bold uppercase tracking-wide text-stone-500">Orçamento</p>
            <p className="text-xl font-black text-marca-600">{q.number}</p>
            <p className="text-xs text-stone-600">Emitido em {dateUtcBR(q.created_at)}</p>
            {q.valid_until && <p className="text-xs text-stone-600">Válido até {dateBR(q.valid_until)}</p>}
            <p className="text-xs text-stone-600">Status: {statusLabel(QUOTE_STATUS, q.status)}</p>
          </div>
        </header>

        {/* cliente */}
        <section className="mt-5">
          <h2 className="mb-1.5 text-xs font-bold uppercase tracking-wide text-marca-600">Cliente</h2>
          <div className="rounded-lg bg-nuvem-100 px-3 py-2.5 text-sm">
            <p className="font-bold">{q.customer_name}</p>
            {q.customer_doc && <p className="text-stone-700">CPF/CNPJ: {docBR(q.customer_doc)}</p>}
            {q.customer_phone && <p className="text-stone-700">Telefone: {phoneBR(q.customer_phone)}</p>}
            {q.customer_whatsapp && q.customer_whatsapp !== q.customer_phone && (
              <p className="text-stone-700">WhatsApp: {phoneBR(q.customer_whatsapp)}</p>
            )}
            {q.customer_email && <p className="text-stone-700">E-mail: {q.customer_email}</p>}
            {enderecoCliente && <p className="text-stone-700">Endereço: {enderecoCliente}</p>}
          </div>
        </section>

        {/* evento */}
        {(q.event_date || enderecoEvento || q.delivery_at || q.pickup_at) && (
          <section className="mt-4">
            <h2 className="mb-1.5 text-xs font-bold uppercase tracking-wide text-marca-600">Evento</h2>
            <div className="rounded-lg bg-nuvem-100 px-3 py-2.5 text-sm text-stone-700">
              {q.event_date && (
                <p>
                  Data do evento: <b className="text-tinta-900">{dateBR(q.event_date)}</b>
                  {q.event_time ? ` às ${q.event_time}` : ""}
                </p>
              )}
              {q.delivery_at && <p>Entrega prevista: {dateBR(q.delivery_at)} {timeBR(q.delivery_at)}</p>}
              {q.pickup_at && <p>Retirada prevista: {dateBR(q.pickup_at)} {timeBR(q.pickup_at)}</p>}
              {enderecoEvento && <p>Local: {enderecoEvento}</p>}
            </div>
          </section>
        )}

        {/* itens */}
        <section className="mt-5">
          <h2 className="mb-1.5 text-xs font-bold uppercase tracking-wide text-marca-600">Itens</h2>
          <div className="scroll-x">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="bg-marca-600 text-white">
                  <th className="px-2 py-2 text-left font-semibold">Descrição</th>
                  <th className="w-16 px-2 py-2 text-right font-semibold">Qtd</th>
                  <th className="w-28 px-2 py-2 text-right font-semibold">Valor un.</th>
                  <th className="w-28 px-2 py-2 text-right font-semibold">Subtotal</th>
                </tr>
              </thead>
              <tbody>
                {itens.map((i: any) => (
                  <tr key={i.id} className="border-b border-nuvem-200">
                    <td className="px-2 py-2">{i.product_name}</td>
                    <td className="px-2 py-2 text-right">{i.qty}</td>
                    <td className="px-2 py-2 text-right">{money(i.unit_price_cents)}</td>
                    <td className="px-2 py-2 text-right font-semibold">{money(i.subtotal_cents)}</td>
                  </tr>
                ))}
                {servicos.map((l) => (
                  <tr key={l.rotulo} className="border-b border-nuvem-200">
                    <td className="px-2 py-2" colSpan={3}>
                      {l.rotulo}
                    </td>
                    <td className="px-2 py-2 text-right font-semibold">{money(l.valor)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* totais */}
        <section className="mt-4 flex justify-end">
          <div className="w-full max-w-xs text-sm">
            {temDesconto && (
              <>
                <Linha rotulo="Subtotal" valor={money(subtotal)} />
                <Linha rotulo="Desconto" valor={`- ${money(q.discount_cents)}`} />
              </>
            )}
            <div className="mt-1 flex items-center justify-between rounded-lg bg-marca-600 px-3 py-2.5 text-white">
              <span className="text-xs font-bold uppercase tracking-wide">Total do Orçamento</span>
              <span className="text-lg font-black">{money(q.total_cents)}</span>
            </div>
          </div>
        </section>

        {/* pagamento */}
        {(s.pix_key || s.bank_info) && (
          <section className="mt-5">
            <h2 className="mb-1.5 text-xs font-bold uppercase tracking-wide text-marca-600">Condições de Pagamento</h2>
            <div className="rounded-lg bg-nuvem-100 px-3 py-2.5 text-sm text-stone-700">
              {s.pix_key && (
                <p>
                  Pix: <b className="text-tinta-900">{s.pix_key}</b>
                </p>
              )}
              {s.bank_info && <p className="whitespace-pre-wrap">{s.bank_info}</p>}
            </div>
          </section>
        )}

        {/* observacoes */}
        {q.notes && (
          <section className="mt-4">
            <h2 className="mb-1.5 text-xs font-bold uppercase tracking-wide text-marca-600">Observações</h2>
            <p className="whitespace-pre-wrap rounded-lg bg-nuvem-100 px-3 py-2.5 text-sm text-stone-700">{q.notes}</p>
          </section>
        )}

        <footer className="mt-6 border-t border-nuvem-300 pt-3 text-center text-xs text-stone-500">
          <p className="font-semibold text-tinta-900">{s.company_name}</p>
          {contatoEmpresa && <p>{contatoEmpresa}</p>}
        </footer>
      </article>
    </div>
  );
}

function Linha({ rotulo, valor }: { rotulo: string; valor: string }) {
  return (
    <div className="flex items-center justify-between border-b border-nuvem-200 py-1.5">
      <span className="text-stone-600">{rotulo}</span>
      <span className="font-medium">{valor}</span>
    </div>
  );
}
