import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { one } from "@/lib/db";
import { requireModule } from "@/lib/auth";
import { ehAdmin } from "@/lib/roles";
import { getSettings } from "@/lib/settings";
import { CONTRACT_STATUS } from "@/lib/domain";
import { dateBR, dateTimeBR, dateUtcBR, utcParaLocal } from "@/lib/format";
import { Alerta, Card, PageHeader, Section, StatusBadge } from "@/components/ui";
import { SubmitButton } from "@/components/SubmitButton";
import { assinaturasDoContrato } from "@/lib/assinatura-db";
import { getCompanySignature } from "@/lib/assinatura-empresa";
import LinkAssinatura from "@/components/LinkAssinatura";
import ContratoTexto from "@/components/ContratoTexto";
import {
  gerarLinkAssinatura,
  regenerateContract,
  revogarLinkAssinatura,
  saveContractBody,
  setContractStatus,
  substituirContrato,
} from "../actions";
import PrintButton from "./PrintButton";

export const dynamic = "force-dynamic";

export default async function ContratoPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ erro?: string; editar?: string; token?: string }>;
}) {
  /* company_id vem SEMPRE do contexto autenticado: o contrato da URL so
     resolve se pertencer a esta empresa (fecha o IDOR por id). */
  const ctx = await requireModule("contratos");
  const user = ctx.user;
  const cid = ctx.companyId;
  const { id } = await params;
  const sp = await searchParams;
  const c = await one<any>(
    `SELECT ct.*, r.number AS reservation_number, cu.name AS customer_name
       FROM contracts ct JOIN reservations r ON r.id = ct.reservation_id JOIN customers cu ON cu.id = r.customer_id
      WHERE ct.id = ? AND ct.company_id = ?`,
    [Number(id), cid],
  );
  if (!c) notFound();
  const s = await getSettings();
  const assinaturas = await assinaturasDoContrato(c.id, cid);
  /**
   * Bloco da empresa no rodape do documento: so entra quando a assinatura ja
   * estava cadastrada NO MOMENTO DA GERACAO (flag company_signature_included,
   * gravada em ensureContract/regenerateContract). Contratos anteriores ficam
   * com NULL e o bloco continua fora — documento pronto nao muda.
   */
  const mostraAssinaturaEmpresa = c.company_signature_included === 1;
  const assinaturaEmpresa = mostraAssinaturaEmpresa ? await getCompanySignature() : null;
  const pendente = assinaturas.find((a: any) => a.status === "pendente");
  const assinada = assinaturas.find((a: any) => a.status === "assinado");
  /**
   * Contrato revogado: substituido por outro ou cancelado. O documento e a
   * assinatura continuam arquivados, mas nada aqui gera link novo ou reabre
   * status — o vigente e o substituto.
   */
  const substituto = c.superseded_by_id
    ? await one<any>(`SELECT id, number FROM contracts WHERE id = ? AND company_id = ?`, [c.superseded_by_id, cid])
    : null;
  const revogado = c.status === "cancelado" || !!c.superseded_by_id;
  const cliente = await one<any>(
    `SELECT cu.whatsapp, cu.phone FROM reservations r JOIN customers cu ON cu.id = r.customer_id WHERE r.id = ? AND r.company_id = ?`,
    [c.reservation_id, cid],
  );
  const zap = String(cliente?.whatsapp || cliente?.phone || "").replace(/\D/g, "");
  // o endereco publico sai do proprio host da requisicao: assim o link funciona
  // em producao, em preview e no ambiente local sem nenhuma configuracao
  const cabecalhos = await headers();
  const host = cabecalhos.get("host") ?? "";
  const esquema = host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https";
  const baseUrl = host ? `${esquema}://${host}` : "";

  return (
    <div className="space-y-4">
      <div className="nao-imprimir space-y-4">
        <PageHeader
          title={c.number}
          subtitle={`${c.customer_name} · reserva ${c.reservation_number}`}
          action={
            <>
              <PrintButton />
              <Link
                href={`/reservas/${c.reservation_id}`}
                className="inline-flex items-center rounded-xl border border-nuvem-300 bg-white px-4 py-2.5 text-sm font-semibold"
              >
                Ver reserva
              </Link>
            </>
          }
        />

        {sp.erro && <Alerta tone="vermelho">{sp.erro}</Alerta>}

        {revogado && (
          <Alerta tone="vermelho" title={c.superseded_by_id ? "Contrato substituído" : "Contrato cancelado"}>
            {c.superseded_by_id ? (
              <>
                Este documento foi revogado
                {c.revoked_at ? ` em ${dateTimeBR(c.revoked_at)}` : ""} e substituído por{" "}
                {substituto ? (
                  <Link href={`/contratos/${substituto.id}`} className="font-bold underline">
                    {substituto.number}
                  </Link>
                ) : (
                  "outro contrato"
                )}
                .
              </>
            ) : (
              <>Este documento foi cancelado{c.revoked_at ? ` em ${dateTimeBR(c.revoked_at)}` : ""}.</>
            )}
            {c.revoked_reason ? ` Motivo: ${c.revoked_reason}.` : ""} A via assinada e o histórico continuam
            arquivados para consulta e auditoria.
          </Alerta>
        )}

        <Section title="Assinatura Virtual">
          {revogado ? (
            <p className="text-sm text-stone-600">
              O link deste contrato foi revogado. Gere um novo link a partir do contrato vigente da reserva.
            </p>
          ) : assinada ? (
            <>
              <Alerta tone="verde" title="Contrato assinado">
                Assinado por {assinada.signer_name} em {dateTimeBR(assinada.signed_at)}. A versão assinada está
                congelada: editar o contrato aqui não altera o documento que o cliente aceitou.
              </Alerta>
              <div className="mt-2 flex flex-wrap items-center gap-3">
                <Link
                  href={`/contratos/assinado/${assinada.id}`}
                  className="rounded-xl border border-nuvem-300 bg-white px-4 py-2.5 text-sm font-semibold"
                >
                  Ver Documento Assinado
                </Link>
                {assinada.document_hash && (
                  <span className="text-xs text-stone-400">
                    verificação SHA-256 {String(assinada.document_hash).slice(0, 16)}…
                  </span>
                )}
              </div>
            </>
          ) : (
            <>
              {sp.token && (
                <div className="mb-3">
                  <LinkAssinatura url={`${baseUrl}/assinar/${sp.token}`} whatsapp={zap || null} />
                </div>
              )}
              {pendente ? (
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-tinta-900">Link ativo, aguardando assinatura</p>
                    <p className="text-xs text-stone-500">
                      Criado em {utcParaLocal(pendente.created_at)}
                      {pendente.expires_at ? ` · expira em ${dateTimeBR(pendente.expires_at)}` : " · sem expiração"}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <form action={gerarLinkAssinatura}>
                      <input type="hidden" name="id" value={c.id} />
                      <SubmitButton variant="secundario">Gerar novo link</SubmitButton>
                    </form>
                    <form action={revogarLinkAssinatura}>
                      <input type="hidden" name="id" value={pendente.id} />
                      <input type="hidden" name="contract_id" value={c.id} />
                      <SubmitButton variant="perigo" confirm="Revogar este link? O cliente não conseguirá mais assinar.">
                        Revogar
                      </SubmitButton>
                    </form>
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="text-sm text-stone-600">
                    Gere um link exclusivo para o cliente ler e assinar pelo celular, sem cadastro nem aplicativo.
                  </p>
                  <form action={gerarLinkAssinatura}>
                    <input type="hidden" name="id" value={c.id} />
                    <SubmitButton>Gerar Link para Assinatura</SubmitButton>
                  </form>
                </div>
              )}
            </>
          )}
        </Section>

        <Card>
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge defs={CONTRACT_STATUS} value={c.status} />
            {c.sent_at && <span className="text-xs text-stone-500">Enviado em {dateBR(c.sent_at)}</span>}
            {c.signed_at && <span className="text-xs text-stone-500">Assinado em {dateBR(c.signed_at)}</span>}
          </div>

          {!revogado && (
          <form action={setContractStatus} className="mt-3 flex flex-wrap items-end gap-2">
            <input type="hidden" name="id" value={c.id} />
            <label className="min-w-[8rem]">
              <span className="rotulo">Status</span>
              <select name="status" defaultValue={c.status} className="campo">
                {CONTRACT_STATUS.map((st) => (
                  <option key={st.value} value={st.value}>
                    {st.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="min-w-[10rem] flex-1">
              <span className="rotulo">Nome de quem assinou</span>
              <input name="signer_name" defaultValue={c.signer_name ?? ""} className="campo" />
            </label>
            <SubmitButton>Salvar</SubmitButton>
          </form>
          )}

          {!revogado && (
          <div className="mt-3 flex flex-wrap gap-2">
            <form action={regenerateContract}>
              <input type="hidden" name="id" value={c.id} />
              <SubmitButton
                variant="secundario"confirm="Regerar o texto com os dados atuais da reserva? O texto atual será substituído.">
                Regerar Texto
              </SubmitButton>
            </form>
            {ehAdmin(user.role) && (
              <Link
                href={`/contratos/${c.id}?editar=1`}
                className="inline-flex items-center rounded-xl border border-nuvem-300 bg-white px-4 py-2.5 text-sm font-semibold"
              >
                Editar Texto
              </Link>
            )}
          </div>
          )}
        </Card>

        {!revogado && (
          <Card>
            <h3 className="text-sm font-bold text-tinta-900">Substituir contrato</h3>
            <p className="mt-1 text-xs text-stone-600">
              Revoga este documento e gera um novo com os dados atuais da empresa. A reserva, os valores, os
              pagamentos e a caução não mudam; a versão anterior (inclusive assinada) fica arquivada para auditoria.
            </p>
            <form action={substituirContrato} className="mt-3 flex flex-wrap items-end gap-2">
              <input type="hidden" name="id" value={c.id} />
              <input type="hidden" name="reservation_id" value={c.reservation_id} />
              <label className="min-w-[14rem] flex-1">
                <span className="rotulo">Motivo da substituição</span>
                <input
                  name="motivo"
                  required
                  minLength={3}
                  maxLength={300}
                  className="campo"
                  placeholder="Ex.: dados cadastrais da locadora atualizados"
                />
              </label>
              <SubmitButton
                variant="perigo"
                confirm="Substituir este contrato? Ele será revogado e um novo será gerado com os dados atuais."
              >
                Substituir contrato
              </SubmitButton>
            </form>
          </Card>
        )}

        {sp.editar === "1" && ehAdmin(user.role) && !revogado && (
          <Card>
            <form action={saveContractBody} className="space-y-2">
              <input type="hidden" name="id" value={c.id} />
              <textarea name="body" defaultValue={c.body} rows={20} className="campo font-mono text-xs" />
              <SubmitButton>Salvar Texto</SubmitButton>
            </form>
          </Card>
        )}
      </div>

      {/* documento imprimivel */}
      <article className="cartao imprimivel p-6 sm:p-10">
        <header className="mb-6 flex items-center gap-3 border-b border-nuvem-300 pb-4">
          {s.company_logo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={s.company_logo} alt="" className="h-14 w-14 rounded-xl object-contain" />
          ) : (
            <span className="flex h-14 w-14 items-center justify-center rounded-xl bg-marca-600 text-2xl font-black text-white">
              L
            </span>
          )}
          <div>
            <p className="text-lg font-black text-tinta-900">{s.company_name}</p>
            <p className="text-xs text-stone-500">
              {[s.company_doc, s.company_phone, s.company_city].filter(Boolean).join(" - ")}
            </p>
          </div>
          <span className="ml-auto text-right text-xs text-stone-500">
            <span className="block font-bold text-tinta-900">{c.number}</span>
            {dateUtcBR(c.created_at)}
          </span>
        </header>
        <ContratoTexto texto={c.body} className="text-[0.82rem] leading-relaxed text-tinta-900" />

        {mostraAssinaturaEmpresa && (
          <section className="mt-10 border-t border-nuvem-200 pt-4">
            <div className="flex flex-wrap items-end justify-between gap-6">
              <div className="text-center">
                {assinaturaEmpresa ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={assinaturaEmpresa.url}
                    alt="Assinatura da empresa"
                    className="h-24 max-w-[220px] object-contain"
                  />
                ) : (
                  /* sem assinatura cadastrada hoje: a area segue em branco,
                     mas o contrato continua valendo como sempre valeu */
                  <div className="h-24 w-[220px]" />
                )}
                <p className="mt-1 border-t border-tinta-900 pt-1 text-sm font-semibold text-tinta-900">
                  {s.company_name}
                </p>
                <p className="text-xs text-stone-500">LOCADORA · assinatura digital</p>
              </div>
              <div className="text-center">
                <div className="h-24 w-[220px]" />
                <p className="mt-1 border-t border-tinta-900 pt-1 text-sm font-semibold text-tinta-900">
                  {c.customer_name}
                </p>
                <p className="text-xs text-stone-500">LOCATÁRIO</p>
              </div>
            </div>
          </section>
        )}
      </article>
    </div>
  );
}
