import Link from "next/link";
import { notFound } from "next/navigation";
import { acompanhamentoPorToken, dadosPix } from "@/lib/loja-publico";
import { ESTADOS_PAGAMENTO, ESTADOS_PEDIDO } from "@/lib/loja";
import { statusDef } from "@/lib/domain";
import EnviarComprovante from "./EnviarComprovante";
import CopiarTexto from "./CopiarTexto";

export const dynamic = "force-dynamic";

export const metadata = { robots: { index: false, follow: false } };

const brl = (c: number) =>
  `R$ ${(Number(c || 0) / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const dataBR = (iso: string) => (iso ? iso.slice(0, 10).split("-").reverse().join("/") : "-");

const ROTULO_FRETE: Record<string, string> = {
  nao_calculado: "não calculado (será definido pela locadora)",
  calculado: "calculado",
  pendente: "pendente de confirmação",
  isento: "isento (retirada)",
};

/**
 * Acompanhamento + pagamento por token: sem conta, sem senha, sem enumeração
 * (token de 24 bytes; só o hash existe no banco). Exibe o mínimo necessário:
 * status, itens, valores, dados Pix do pedido e envio de comprovante.
 */
export default async function AcompanhamentoPage({ params }: { params: Promise<{ slug: string; token: string }> }) {
  const { slug, token } = await params;
  const r = await acompanhamentoPorToken(slug, token);
  if (!r.ok) {
    return (
      <main className="mx-auto max-w-2xl px-4 py-16 text-center">
        <h1 className="mb-2 text-xl font-bold">Link inválido</h1>
        <p className="mb-6 text-sm opacity-70">{r.erro}</p>
        <Link href={`/loja/${slug}`} className="underline">
          Ir para a loja
        </Link>
      </main>
    );
  }
  const { pedido, loja } = r;
  const estado = statusDef(ESTADOS_PEDIDO, pedido.status);
  const pag = statusDef(ESTADOS_PAGAMENTO, pedido.payment_status);

  const precisaPagamento =
    loja.pix_enabled === 1 &&
    (pedido.status === "aprovada_aguardando_pagamento" || (pedido.status === "confirmada" && pedido.totals.total_cents > 0));
  const pix = precisaPagamento
    ? await dadosPix(loja, pedido.status === "aprovada_aguardando_pagamento" ? pedido.totals.signal_cents || pedido.totals.total_cents : pedido.totals.total_cents, pedido.number)
    : null;

  const podeEnviarComprovante =
    pedido.payment_status !== "confirmado" && pedido.status !== "cancelada" && pedido.status !== "recusada" && pedido.status !== "expirada";

  return (
    <main className="mx-auto max-w-2xl px-4 pb-16 pt-6">
      <p className="mb-4 text-sm">
        <Link href={`/loja/${loja.slug}`} className="underline">
          ← {loja.display_name || "Loja"}
        </Link>
      </p>

      <div className="mb-4 rounded-2xl p-4" style={{ background: "var(--loja-card)" }}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-xl font-bold">Pedido {pedido.number}</h1>
          <span className="rounded-full border px-2 py-0.5 text-xs font-semibold" style={{ borderColor: "var(--loja-accent)" }}>
            {estado.label}
          </span>
        </div>
        <p className="mt-1 text-sm opacity-70">
          Evento em {dataBR(pedido.event_date)} · {pedido.kind === "orcamento" ? "solicitação de orçamento" : "solicitação de reserva"}
        </p>
        {pedido.payment_status !== "nao_informado" && (
          <p className="mt-1 text-sm">
            Pagamento: <b>{pag.label}</b>
          </p>
        )}
        {pedido.payment_deadline_at && pedido.status === "aprovada_aguardando_pagamento" && (
          <p className="mt-1 text-sm">
            Prazo para pagamento: até {pedido.payment_deadline_at.replace("T", " ")}
          </p>
        )}
        {pedido.status === "expirada" && (
          <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
            O prazo de pagamento expirou e a reserva foi liberada. Fale com a locadora para verificar a disponibilidade.
          </p>
        )}
        {pedido.status === "aguardando_analise" && (
          <p className="mt-2 text-sm opacity-70">Sua solicitação está em análise. Você receberá a resposta pelo contato informado.</p>
        )}
      </div>

      <section className="mb-4 rounded-2xl p-4" style={{ background: "var(--loja-card)" }}>
        <h2 className="mb-2 text-lg font-bold">Itens</h2>
        <ul className="text-sm">
          {pedido.itens.map((i, idx) => (
            <li key={idx} className="flex justify-between border-b py-2 last:border-0" style={{ borderColor: "var(--loja-accent)" }}>
              <span>
                {i.qty}× {i.name}
              </span>
              <span>{brl(i.subtotal_cents)}</span>
            </li>
          ))}
        </ul>
        <div className="mt-2 space-y-1 text-sm">
          <div className="flex justify-between">
            <span>Itens</span>
            <span>{brl(pedido.totals.items_cents)}</span>
          </div>
          <div className="flex justify-between">
            <span>Frete ({ROTULO_FRETE[pedido.freight_status] ?? pedido.freight_status})</span>
            <span>{brl(pedido.totals.freight_cents)}</span>
          </div>
          <div className="flex justify-between border-t pt-2 text-base font-bold" style={{ borderColor: "var(--loja-accent)" }}>
            <span>Total</span>
            <span>{brl(pedido.totals.total_cents)}</span>
          </div>
          {pedido.totals.signal_cents > 0 && (
            <div className="flex justify-between">
              <span>Sinal a pagar agora</span>
              <b>{brl(pedido.totals.signal_cents)}</b>
            </div>
          )}
        </div>
        <p className="mt-2 text-xs opacity-60">
          Valores registrados no envio. Alterações só acontecem após análise da locadora, que entra em contato.
        </p>
      </section>

      {pix && (
        <section className="mb-4 rounded-2xl p-4" style={{ background: "var(--loja-card)" }}>
          <h2 className="mb-2 text-lg font-bold">Pagamento Pix</h2>
          <div className="space-y-1 text-sm">
            <p>
              Recebedor: <b>{pix.holder || loja.display_name}</b>
            </p>
            <p className="flex flex-wrap items-center gap-2">
              Chave: <b className="font-mono">{pix.key}</b> <CopiarTexto valor={pix.key} rotulo="Copiar chave" />
            </p>
            {pix.city && <p className="text-xs opacity-60">Cidade do recebedor: {pix.city}</p>}
            {pix.instructions && <p className="mt-2 whitespace-pre-line">{pix.instructions}</p>}
          </div>
          {pix.payload && (
            <div className="mt-3">
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide opacity-60">Pix copia e cola (valor do pedido)</p>
              <div className="flex items-start gap-2">
                <code className="block flex-1 break-all rounded-lg border p-2 text-xs" style={{ borderColor: "var(--loja-accent)" }}>
                  {pix.payload}
                </code>
                <CopiarTexto valor={pix.payload} rotulo="Copiar código" />
              </div>
            </div>
          )}
          {!pix.payload && (
            <p className="mt-2 text-xs text-amber-700">Não foi possível gerar o código Pix agora; use a chave acima.</p>
          )}
          <p className="mt-3 text-xs opacity-70">
            O valor é pago direto à locadora. Enviar o comprovante abaixo NÃO confirma o pagamento: a locadora analisa e confirma.
          </p>
        </section>
      )}

      <section className="mb-4 rounded-2xl p-4" style={{ background: "var(--loja-card)" }}>
        <h2 className="mb-2 text-lg font-bold">Comprovante de pagamento</h2>
        {pedido.comprovante ? (
          <p className="mb-2 text-sm">
            Comprovante recebido em {pedido.comprovante.submitted_at} —{" "}
            <b>
              {pedido.comprovante.status === "confirmado"
                ? "confirmado"
                : pedido.comprovante.status === "recusado"
                  ? "não identificado"
                  : "aguardando verificação"}
            </b>
            .
          </p>
        ) : (
          <p className="mb-2 text-sm opacity-70">Nenhum comprovante enviado ainda.</p>
        )}
        {podeEnviarComprovante && <EnviarComprovante slug={loja.slug} token={token} />}
      </section>

      <p className="text-center text-xs opacity-60">
        Guarde este link: ele é o único acesso ao andamento do pedido, que não fica indexado nem disponível para terceiros.
      </p>
    </main>
  );
}
