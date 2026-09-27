import { notFound } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { obterRecibo } from "@/lib/recibos";
import { dateBR, dateUtcBR, docBR, money, phoneBR } from "@/lib/format";
import { formaLabel, sanitizarNomeArquivo, tamanhoRecibo, valorPorExtenso } from "@/lib/recibo-visual";
import { getCompanySignature } from "@/lib/assinatura-empresa";
import PrintButton from "@/app/(app)/contratos/[id]/PrintButton";

export const dynamic = "force-dynamic";

/**
 * Recibo de lançamento (pagamento, adiantamento ou caução) e recibo
 * unificado de quitação.
 *
 * Página própria, fora do fluxo de lançamento: o lançamento já aconteceu, e
 * esta tela apenas lê os dados reais dele na hora da exibição e o snapshot
 * registrado na emissão. Nada aqui escreve no banco. A impressão e o PDF
 * usam o mesmo mecanismo dos contratos e orçamentos (dialogo de impressão do
 * navegador), reaproveitando o CSS .imprimivel/.nao-imprimir já existente.
 *
 * Tamanho configurável: a folha usa a configuração "recibo_tamanho"
 * (Configurações → Recibos), via @page size no papel e largura fixa na tela —
 * o tamanho configurado é o que sai na impressão, sem ajuste manual de
 * escala. A4 continua o padrão e o layout se reorganiza nos formatos
 * compactos (margens e tipografia menores), sem remover informação.
 *
 * Documentos já emitidos não são reescritos: o tamanho vale para a exibição
 * e novas impressões, e o conteúdo impresso continua sendo o snapshot da
 * emissão.
 */
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const r = await obterRecibo(Number(id));
  if (!r) return { title: "Recibo" };
  const cliente = sanitizarNomeArquivo(r.cliente?.name);
  return { title: `Recibo-${sanitizarNomeArquivo(r.recibo.number)}${cliente ? `-${cliente}` : ""}` };
}

export default async function ReciboPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ aviso?: string }>;
}) {
  await requireUser();
  const { id } = await params;
  const { aviso } = await searchParams;
  const data = await obterRecibo(Number(id));
  if (!data) notFound();

  const { recibo, company, cliente, reserva, frete, lancamentoExiste, composicao } = data;
  const s = company as Record<string, string>;
  const ehCaucao = recibo.source_type === "deposit";
  const ehQuitacao = recibo.source_type === "quitacao";
  const ehFrete = !!frete;
  const tipoRotulo = ehQuitacao ? "Quitação" : ehCaucao ? "Caução" : "Pagamento";

  // tamanho configurado (vale para todos os tipos de recibo, inclusive quitação)
  const tamanho = tamanhoRecibo(s);
  // modo compacto: qualquer formato menor que a folha A4 cheia — o ½ A4 é
  // compacto em altura mesmo sendo largo, e o ¼/personalizado em ambos
  const compacto = tamanho.key !== "a4" && (tamanho.larguraMm < 160 || (tamanho.alturaMm ?? 297) < 200);

  const referencia = reserva?.reservation_number ?? frete?.freight_number ?? null;
  const nomeCliente = cliente?.name ?? "—";
  const enderecoEvento = reserva
    ? [reserva.address, reserva.district, reserva.city].filter(Boolean).join(", ")
    : frete
      ? [frete.origin, frete.destination].filter(Boolean).join(" → ")
      : "";
  const contatoEmpresa = [phoneBR(s.company_phone), s.company_email].filter(Boolean).join(" - ");
  const enderecoEmpresa = [s.company_address, s.company_city].filter(Boolean).join(" - ");
  /**
   * Assinatura da empresa: entra apenas quando a flag foi gravada na emissao
   * (company_signature_included, congela o momento). Recibos emitidos antes de
   * existir assinatura, ou com ela removida, continuam exatamente como eram.
   */
  const mostraAssinaturaEmpresa = recibo.company_signature_included === 1;
  const assinaturaEmpresa = mostraAssinaturaEmpresa ? await getCompanySignature() : null;

  /**
   * @page com o tamanho configurado: o papel sai na medida, sem escala
   * manual. Na impressão a folha preenche a área útil (largura fixa é só na
   * tela, senão o conteúdo transborda a margem); na tela, a folha mostra a
   * proporção real do papel escolhido.
   */
  const cssPagina = `
    @page { size: ${tamanho.larguraMm}mm ${tamanho.alturaMm ? `${tamanho.alturaMm}mm` : "auto"}; margin: ${compacto ? 8 : 16}mm; }
    @media print {
      .folha-recibo { width: auto !important; margin: 0 !important; }
      .folha-recibo section { break-inside: avoid; }
    }
  `;

  return (
    <div className="mx-auto space-y-4" style={{ maxWidth: `${tamanho.larguraMm + 60}mm` }}>
      <style>{cssPagina}</style>
      <div className="nao-imprimir flex flex-wrap items-center justify-between gap-2">
        <Link href="/reservas" className="text-sm font-semibold text-marca-600">
          Voltar
        </Link>
        <PrintButton />
      </div>

      {aviso && (
        <div className="nao-imprimir rounded-xl border border-amber-300 bg-amber-50 px-3 py-2.5 text-sm text-amber-900">
          {aviso}
        </div>
      )}

      {data.valorDivergente && lancamentoExiste && (
        <div className="nao-imprimir rounded-xl border border-amber-300 bg-amber-50 px-3 py-2.5 text-sm text-amber-900">
          O valor do lançamento foi alterado após a emissão deste recibo (emitido por{" "}
          {money(recibo.amount_cents)}; hoje o lançamento registra {money(data.valorAtual)}). Os dados abaixo são os
          registrados na emissão; verifique se um novo recibo é necessário.
        </div>
      )}

      <article
        className={`cartao imprimivel folha-recibo bg-white text-tinta-900 ${compacto ? "p-4" : "p-6 sm:p-10"}`}
        style={{ width: `${tamanho.larguraMm}mm`, margin: "0 auto" }}
      >
        {/* cabecalho: empresa, como no orcamento impresso */}
        <header className={`flex flex-wrap items-start justify-between gap-3 border-b-2 border-marca-600 ${compacto ? "pb-2" : "pb-4"}`}>
          <div className="flex items-center gap-2">
            {s.company_logo ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={s.company_logo} alt="" className={`${compacto ? "h-10 w-10" : "h-16 w-16"} rounded-xl object-contain`} />
            ) : null}
            <div>
              <p className={`${compacto ? "text-sm" : "text-lg"} font-black leading-tight text-marca-600`}>{s.company_name}</p>
              {s.company_tagline && <p className="text-xs text-stone-500">{s.company_tagline}</p>}
              {s.company_doc && <p className="text-xs text-stone-600">CNPJ/CPF: {docBR(s.company_doc)}</p>}
              {contatoEmpresa && <p className="text-xs text-stone-600">{contatoEmpresa}</p>}
              {!compacto && enderecoEmpresa && <p className="text-xs text-stone-600">{enderecoEmpresa}</p>}
            </div>
          </div>
          <div className="text-right">
            <p className="text-xs font-bold uppercase tracking-wide text-stone-500">Recibo de {tipoRotulo}</p>
            <p className={`${compacto ? "text-base" : "text-xl"} font-black text-marca-600`}>{recibo.number}</p>
            <p className="text-xs text-stone-600">Emitido em {dateUtcBR(recibo.created_at)}</p>
            {recibo.issued_by_name && <p className="text-xs text-stone-500">Por {recibo.issued_by_name}</p>}
          </div>
        </header>

        {ehQuitacao ? (
          <>
            {/* declaração de quitação */}
            <section className={compacto ? "mt-3" : "mt-6"}>
              <p className={`${compacto ? "text-sm" : "text-base"} font-bold uppercase tracking-wide text-marca-700`}>
                Declaração de quitação
              </p>
              <p className={`${compacto ? "text-sm" : "text-base"} leading-relaxed text-stone-800`}>
                Recebemos de <b className="text-tinta-900">{nomeCliente}</b>
                {cliente?.doc ? (
                  <>
                    {" "}
                    (CPF/CNPJ <span className="text-stone-700">{docBR(cliente.doc)}</span>)
                  </>
                ) : null}
                {cliente?.phone ? (
                  <>
                    {" "}
                    · fone <span className="text-stone-700">{phoneBR(cliente.phone)}</span>
                  </>
                ) : null}{" "}
                os valores abaixo, ficando{" "}
                <b className="text-tinta-900">
                  totalmente quitada a obrigação {recibo.obrigacao_tipo === "caucao" ? "da caução" : "da locação"} da
                  locação {referencia ?? "—"}
                </b>
                .
              </p>
              <div
                className={`mt-3 rounded-lg border-2 border-marca-600 text-center ${compacto ? "px-3 py-2" : "px-4 py-3"}`}
              >
                <p className="text-xs font-bold uppercase tracking-wide text-stone-500">Valor total quitado</p>
                <p className={`${compacto ? "text-xl" : "text-2xl"} font-black text-marca-700`}>
                  {money(recibo.amount_cents)}
                </p>
                <p className="text-xs text-stone-600">{valorPorExtenso(recibo.amount_cents)}</p>
              </div>
              {/* composição: os lançamentos que compõem o total, congelados na emissão.
                  No ¼ A4 a composição colapsa para uma linha de resumo para caber —
                  reorganizar, não cortar. */}
              {composicao.length > 0 && (
                <div className="mt-3">
                  <h2 className="mb-1 text-xs font-bold uppercase tracking-wide text-marca-600">
                    Composição do total
                  </h2>
                  {compacto ? (
                    <p className="text-sm text-stone-700">
                      {composicao.length} lançamento(s): {composicao.map((l) => money(l.amount)).join(" + ")}
                    </p>
                  ) : (
                    <ul className="divide-y divide-nuvem-200 rounded-lg border border-nuvem-200">
                      {composicao.map((l) => (
                        <li key={l.id} className="flex items-center justify-between px-3 py-1.5 text-sm">
                          <span className="text-stone-500">Lançamento #{l.id}</span>
                          <span className="font-medium text-tinta-900">{money(l.amount)}</span>
                        </li>
                      ))}
                      <li className="flex items-center justify-between bg-nuvem-50 px-3 py-1.5 text-sm font-bold">
                        <span>Total</span>
                        <span className="text-marca-700">{money(recibo.amount_cents)}</span>
                      </li>
                    </ul>
                  )}
                </div>
              )}
              <p className="mt-3 text-xs text-stone-600">
                Data do último recebimento: <b>{dateBR(data.dataAtual)}</b> · Forma: {formaLabel(data.methodAtual)}
              </p>
              <p className="mt-2 rounded-lg bg-nuvem-100 px-3 py-2 text-xs text-stone-600">
                Este recibo é adicional aos recibos individuais de cada recebimento e declara a quitação integral da
                obrigação:
              </p>
              <p className="whitespace-pre-wrap rounded-lg bg-nuvem-100 px-3 py-2.5 text-sm text-stone-700">
                {recibo.body}
              </p>
            </section>
          </>
        ) : lancamentoExiste ? (
          <>
            {/* declaracao principal */}
            <section className={compacto ? "mt-3" : "mt-6"}>
              <p className={`${compacto ? "text-sm" : "text-base"} leading-relaxed text-stone-800`}>
                Recebemos de <b className="text-tinta-900">{nomeCliente}</b>
                {cliente?.doc ? (
                  <>
                    {" "}
                    (CPF/CNPJ <span className="text-stone-700">{docBR(cliente.doc)}</span>)
                  </>
                ) : null}
                {cliente?.phone ? (
                  <>
                    {" "}
                    · fone <span className="text-stone-700">{phoneBR(cliente.phone)}</span>
                  </>
                ) : null}{" "}
                a importância de{" "}
                <b className={`${compacto ? "text-base" : "text-lg"} text-marca-700`}>{money(data.valorAtual)}</b>{" "}
                ({valorPorExtenso(data.valorAtual)}){ehCaucao ? ", a título de caução" : ""}, referente
                {ehCaucao ? " à" : ""}{" "}
                <b className="text-tinta-900">
                  {ehCaucao
                    ? `caução da locação ${referencia ?? "—"}`
                    : `locação ${referencia ?? "—"}`}
                </b>
                .
              </p>
              <p className="mt-3 rounded-lg bg-nuvem-100 px-3 py-2 text-xs text-stone-600">
                Esta declaração foi registrada na emissão do recibo e permanece como comprovante:
              </p>
              <p className="whitespace-pre-wrap rounded-lg bg-nuvem-100 px-3 py-2.5 text-sm text-stone-700">
                {recibo.body}
              </p>
            </section>

            {/* dados do lancamento */}
            <section className={compacto ? "mt-3" : "mt-5"}>
              <h2 className="mb-1.5 text-xs font-bold uppercase tracking-wide text-marca-600">Dados do recebimento</h2>
              <div className="rounded-lg border border-nuvem-200">
                <Linha rotulo="Tipo de lançamento" valor={ehCaucao ? "Caução" : "Pagamento"} destaque />
                <Linha rotulo="Valor recebido" valor={money(data.valorAtual)} destaque />
                <Linha rotulo="Data do recebimento" valor={dateBR(data.dataAtual)} />
                <Linha rotulo="Forma de pagamento" valor={formaLabel(data.methodAtual)} />
                {data.descricao && <Linha rotulo="Descrição / observação" valor={data.descricao} />}
                {recibo.method && recibo.method !== data.methodAtual && (
                  <Linha rotulo="Forma registrada na emissão" valor={formaLabel(recibo.method)} />
                )}
              </div>
            </section>

            {/* identificacao da reserva ou do frete */}
            {referencia && (
              <section className={compacto ? "mt-3" : "mt-4"}>
                <h2 className="mb-1.5 text-xs font-bold uppercase tracking-wide text-marca-600">
                  {ehFrete ? "Frete" : "Reserva"}
                </h2>
                <div className="rounded-lg bg-nuvem-100 px-3 py-2.5 text-sm text-stone-700">
                  <p>
                    Número: <b className="text-tinta-900">{referencia}</b>
                  </p>
                  {reserva?.event_date && (
                    <p>
                      Data do evento: {dateBR(reserva.event_date)}
                      {reserva.event_time ? ` às ${reserva.event_time}` : ""}
                    </p>
                  )}
                  {frete?.freight_date && <p>Data do frete: {dateBR(frete.freight_date)}</p>}
                  {enderecoEvento && <p>Local / trajeto: {enderecoEvento}</p>}
                </div>
              </section>
            )}

            {!ehCaucao && ehFrete && (
              <p className="mt-3 text-xs text-stone-500">
                Recibo emitido sobre um pagamento de frete; o tipo exato do lançamento é o registrado no sistema.
              </p>
            )}
          </>
        ) : (
          <section className={compacto ? "mt-3" : "mt-6"}>
            <p className="rounded-xl border border-amber-300 bg-amber-50 px-3 py-3 text-sm text-amber-900">
              O lançamento original deste recibo não existe mais no sistema (por exemplo, a reserva foi excluída). O
              recibo permanece registrado como comprovante da emissão, com os dados abaixo capturados na data em que
              foi gerado.
            </p>
            <div className="mt-4 rounded-lg border border-nuvem-200">
              <Linha rotulo="Tipo" valor={tipoRotulo} />
              <Linha rotulo="Valor emitido" valor={money(recibo.amount_cents)} destaque />
              <Linha rotulo="Data do recebimento" valor={dateBR(recibo.paid_at)} />
              <Linha rotulo="Forma" valor={formaLabel(recibo.method)} />
            </div>
          </section>
        )}

        {mostraAssinaturaEmpresa && (
          <section className={`${compacto ? "mt-5" : "mt-10"} flex justify-center`}>
            <div className="text-center">
              {assinaturaEmpresa ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={assinaturaEmpresa.url}
                  alt="Assinatura da empresa"
                  className={`mx-auto object-contain ${compacto ? "h-14 max-w-[160px]" : "h-20 max-w-[220px]"}`}
                />
              ) : (
                /* sem assinatura cadastrada hoje: area vazia, recibo segue valido */
                <div className={`${compacto ? "h-14 w-[160px]" : "h-20 w-[220px]"}`} />
              )}
              <p className={`mt-1 border-t border-tinta-900 pt-1 text-sm font-semibold text-tinta-900`}>
                {s.company_name}
              </p>
              <p className="text-xs text-stone-500">EMPRESA · assinatura digital</p>
            </div>
          </section>
        )}

        <footer className={`border-t border-nuvem-300 pt-2 text-center text-xs text-stone-500 ${compacto ? "mt-3" : "mt-8"}`}>
          <p className="font-semibold text-tinta-900">{s.company_name}</p>
          {contatoEmpresa && <p>{contatoEmpresa}</p>}
        </footer>
      </article>
    </div>
  );
}

function Linha({ rotulo, valor, destaque }: { rotulo: string; valor: string; destaque?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-nuvem-200 px-3 py-2 text-sm last:border-0">
      <span className="text-stone-500">{rotulo}</span>
      <span className={`text-right font-medium ${destaque ? "text-marca-700" : "text-tinta-900"}`}>{valor}</span>
    </div>
  );
}
