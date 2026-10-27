"use client";
import { useEffect, useMemo, useState } from "react";
import { alterarQty, brl, lerCarrinho, limpar, remover, type ItemCarrinho } from "./carrinho";

export type ConfigCheckout = {
  offer_delivery: boolean;
  offer_pickup: boolean;
  require_terms: boolean;
  terms_text: string;
  cancellation_text: string;
  privacy_text: string;
  min_lead_days: number;
  hide_prices: boolean;
  aceitaOrcamento: boolean;
  freight_pending_ok: boolean;
};

/**
 * Carrinho + identificação + data + entrega/frete + envio.
 * Tudo que o cliente digita aqui é validado de novo no servidor; os valores
 * vêm do catálogo e o backend os recalcula antes de gravar.
 */
export default function CheckoutForm({ slug, config }: { slug: string; config: ConfigCheckout }) {
  const [itens, setItens] = useState<ItemCarrinho[]>([]);
  const [nome, setNome] = useState("");
  const [telefone, setTelefone] = useState("");
  const [email, setEmail] = useState("");
  const [doc, setDoc] = useState("");
  const [data, setData] = useState("");
  const [hora, setHora] = useState("");
  const [modalidade, setModalidade] = useState<"entrega" | "retirada">(
    config.offer_delivery ? "entrega" : "retirada",
  );
  const [endereco, setEndereco] = useState("");
  const [bairro, setBairro] = useState("");
  const [cidade, setCidade] = useState("");
  const [cep, setCep] = useState("");
  const [obs, setObs] = useState("");
  const [aceitou, setAceitou] = useState(false);
  const [frete, setFrete] = useState<{ estado: "indefinido" | "calculando" | "ok" | "pendente" | "isento"; cents: number; aviso?: string }>({
    estado: "isento",
    cents: 0,
  });
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => setItens(lerCarrinho(slug)), [slug]);

  const subtotal = itens.reduce((s, i) => s + i.qty * i.unit_price_cents, 0);
  const minData = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() + Math.max(0, config.min_lead_days));
    return d.toISOString().slice(0, 10);
  }, [config.min_lead_days]);

  function alterar(id: number, qty: number) {
    setItens(alterarQty(slug, id, qty));
    window.dispatchEvent(new CustomEvent("loja:carrinho", { detail: { slug, itens: lerCarrinho(slug) } }));
  }

  function excluir(id: number) {
    setItens(remover(slug, id));
    window.dispatchEvent(new CustomEvent("loja:carrinho", { detail: { slug, itens: lerCarrinho(slug) } }));
  }

  async function calcularFrete() {
    if (modalidade !== "entrega") return;
    setFrete({ estado: "calculando", cents: 0 });
    try {
      const r = await fetch(`/api/loja/${slug}/frete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: endereco, district: bairro, city: cidade, zip: cep }),
      });
      const j: any = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.erro || "Não foi possível calcular o frete.");
      if (j.calculado) setFrete({ estado: "ok", cents: Number(j.valor_cents) || 0 });
      else setFrete({ estado: "pendente", cents: 0, aviso: j.aviso });
    } catch (e) {
      setFrete({ estado: "pendente", cents: 0, aviso: (e as Error).message });
    }
  }

  async function enviar(e: React.FormEvent) {
    e.preventDefault();
    setErro(null);
    if (!itens.length) return setErro("Seu pedido está vazio.");
    if (modalidade === "entrega" && frete.estado === "indefinido") {
      setErro("Calcule o frete do endereço (ou clique em calcular) antes de enviar.");
      return;
    }
    if (modalidade === "entrega" && frete.estado !== "ok" && !config.freight_pending_ok) {
      setErro("Não foi possível calcular o frete deste endereço. Fale com a locadora ou confira o endereço.");
      return;
    }
    setEnviando(true);
    try {
      const r = await fetch(`/api/loja/${slug}/pedidos`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          itens: itens.map((i) => ({ product_id: i.product_id, qty: i.qty })),
          cliente: { nome, telefone, email, doc },
          event_date: data,
          event_time: hora,
          modalidade,
          endereco: modalidade === "entrega" ? { address: endereco, district: bairro, city: cidade, zip: cep } : undefined,
          observacoes: obs,
          aceitou_termos: aceitou,
        }),
      });
      const j: any = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.erro || "Não foi possível enviar o pedido. Tente novamente.");
      limpar(slug);
      window.location.href = `/loja/${slug}/pedido/${j.token}`;
    } catch (e) {
      setErro((e as Error).message);
      setEnviando(false);
    }
  }

  if (!itens.length) {
    return (
      <div className="rounded-2xl p-8 text-center" style={{ background: "var(--loja-card)" }}>
        <p className="mb-3 font-semibold">Seu pedido está vazio.</p>
        <a
          href={`/loja/${slug}`}
          className="inline-block px-4 py-2.5 font-bold text-white"
          style={{ background: "var(--loja-primary)", borderRadius: "var(--loja-radius)" }}
        >
          Ver catálogo
        </a>
      </div>
    );
  }

  const campo = "w-full rounded-lg border px-3 py-2 text-sm";
  const estiloCampo = { borderColor: "var(--loja-secondary)", background: "var(--loja-bg)", color: "var(--loja-text)" };

  return (
    <form onSubmit={enviar} className="space-y-4">
      {/* Itens */}
      <section className="rounded-2xl p-4" style={{ background: "var(--loja-card)" }}>
        <h2 className="mb-3 text-lg font-bold">Itens do pedido</h2>
        <ul className="divide-y" style={{ borderColor: "var(--loja-accent)" }}>
          {itens.map((i) => (
            <li key={i.product_id} className="flex items-center gap-3 py-3">
              {i.photo ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={i.photo} alt="" className="h-12 w-12 rounded-lg object-cover" />
              ) : (
                <div className="h-12 w-12 rounded-lg bg-nuvem-100" />
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold">{i.name}</p>
                <p className="text-xs opacity-60">
                  {i.unit_price_cents > 0 && !config.hide_prices ? brl(i.unit_price_cents) : "sob consulta"}
                  {i.pricing_mode === "diaria" ? " / diária" : ""}
                </p>
              </div>
              <div className="flex items-center rounded-lg border" style={{ borderColor: "var(--loja-secondary)" }}>
                <button type="button" className="px-2 py-1 font-bold" onClick={() => alterar(i.product_id, i.qty - 1)} aria-label="Diminuir">
                  −
                </button>
                <span className="w-7 text-center text-sm">{i.qty}</span>
                <button
                  type="button"
                  className="px-2 py-1 font-bold"
                  onClick={() => alterar(i.product_id, Math.min(i.max_qty ?? 999, i.qty + 1))}
                  aria-label="Aumentar"
                >
                  +
                </button>
              </div>
              <span className="w-24 text-right text-sm font-bold">
                {i.unit_price_cents > 0 && !config.hide_prices ? brl(i.unit_price_cents * i.qty) : "—"}
              </span>
              <button type="button" className="text-sm opacity-60 hover:opacity-100" onClick={() => excluir(i.product_id)} aria-label="Remover">
                ✕
              </button>
            </li>
          ))}
        </ul>
        <div className="mt-3 flex justify-between border-t pt-3 text-sm" style={{ borderColor: "var(--loja-accent)" }}>
          <span>Subtotal dos itens</span>
          <b>{config.hide_prices ? "sob consulta" : brl(subtotal)}</b>
        </div>
      </section>

      {/* Data */}
      <section className="rounded-2xl p-4" style={{ background: "var(--loja-card)" }}>
        <h2 className="mb-3 text-lg font-bold">Data do evento</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-sm">
            Data desejada *
            <input type="date" required min={minData} value={data} onChange={(e) => setData(e.target.value)} className={campo} style={estiloCampo} />
          </label>
          <label className="text-sm">
            Horário (opcional)
            <input type="time" value={hora} onChange={(e) => setHora(e.target.value)} className={campo} style={estiloCampo} />
          </label>
        </div>
        {config.min_lead_days > 0 && (
          <p className="mt-2 text-xs opacity-60">Aceitamos pedidos com pelo menos {config.min_lead_days} dia(s) de antecedência.</p>
        )}
      </section>

      {/* Entrega */}
      {(config.offer_delivery || config.offer_pickup) && (
        <section className="rounded-2xl p-4" style={{ background: "var(--loja-card)" }}>
          <h2 className="mb-3 text-lg font-bold">Entrega ou retirada</h2>
          <div className="mb-3 flex flex-wrap gap-2">
            {config.offer_delivery && (
              <button
                type="button"
                onClick={() => {
                  setModalidade("entrega");
                  setFrete({ estado: "indefinido", cents: 0 });
                }}
                className="px-4 py-2 text-sm font-semibold"
                style={
                  modalidade === "entrega"
                    ? { background: "var(--loja-primary)", color: "#fff", borderRadius: "var(--loja-radius)" }
                    : { border: "1px solid var(--loja-secondary)", borderRadius: "var(--loja-radius)" }
                }
              >
                Entrega no endereço
              </button>
            )}
            {config.offer_pickup && (
              <button
                type="button"
                onClick={() => {
                  setModalidade("retirada");
                  setFrete({ estado: "isento", cents: 0 });
                }}
                className="px-4 py-2 text-sm font-semibold"
                style={
                  modalidade === "retirada"
                    ? { background: "var(--loja-primary)", color: "#fff", borderRadius: "var(--loja-radius)" }
                    : { border: "1px solid var(--loja-secondary)", borderRadius: "var(--loja-radius)" }
                }
              >
                Retirada no local
              </button>
            )}
          </div>

          {modalidade === "entrega" ? (
            <div className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="text-sm sm:col-span-2">
                  Rua e número *
                  <input required value={endereco} onChange={(e) => setEndereco(e.target.value)} className={campo} style={estiloCampo} maxLength={200} />
                </label>
                <label className="text-sm">
                  Bairro
                  <input value={bairro} onChange={(e) => setBairro(e.target.value)} className={campo} style={estiloCampo} maxLength={80} />
                </label>
                <label className="text-sm">
                  Cidade *
                  <input required value={cidade} onChange={(e) => setCidade(e.target.value)} className={campo} style={estiloCampo} maxLength={80} />
                </label>
                <label className="text-sm">
                  CEP
                  <input value={cep} onChange={(e) => setCep(e.target.value)} className={campo} style={estiloCampo} maxLength={12} />
                </label>
              </div>
              <button
                type="button"
                onClick={calcularFrete}
                disabled={frete.estado === "calculando"}
                className="px-4 py-2 text-sm font-semibold"
                style={{ border: "1px solid var(--loja-secondary)", borderRadius: "var(--loja-radius)" }}
              >
                {frete.estado === "calculando" ? "Calculando…" : "Calcular frete"}
              </button>
              <p className="text-sm">
                {frete.estado === "ok" && <b>Frete estimado: {brl(frete.cents)}</b>}
                {frete.estado === "pendente" && <span>{frete.aviso || "Frete será confirmado pela locadora."}</span>}
                {frete.estado === "indefinido" && <span className="opacity-60">Informe o endereço e calcule o frete.</span>}
              </p>
            </div>
          ) : (
            <p className="text-sm opacity-70">Retirada no local da locadora — sem custo de frete.</p>
          )}
        </section>
      )}

      {/* Cliente */}
      <section className="rounded-2xl p-4" style={{ background: "var(--loja-card)" }}>
        <h2 className="mb-3 text-lg font-bold">Seus dados</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-sm">
            Nome completo *
            <input required value={nome} onChange={(e) => setNome(e.target.value)} className={campo} style={estiloCampo} maxLength={120} />
          </label>
          <label className="text-sm">
            Telefone / WhatsApp *
            <input
              required
              value={telefone}
              onChange={(e) => setTelefone(e.target.value)}
              className={campo}
              style={estiloCampo}
              placeholder="(11) 99999-8888"
              maxLength={40}
            />
          </label>
          <label className="text-sm">
            E-mail
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className={campo} style={estiloCampo} maxLength={120} />
          </label>
          <label className="text-sm">
            CPF (opcional)
            <input value={doc} onChange={(e) => setDoc(e.target.value)} className={campo} style={estiloCampo} maxLength={14} />
          </label>
          <label className="text-sm sm:col-span-2">
            Observações
            <textarea value={obs} onChange={(e) => setObs(e.target.value)} className={campo} style={estiloCampo} rows={2} maxLength={1000} />
          </label>
        </div>
        <p className="mt-2 text-xs opacity-60">
          Usamos estes dados apenas para responder à sua solicitação (LGPD). Eles não aparecem em páginas públicas nem em links.
        </p>
      </section>

      {/* Termos */}
      {config.require_terms && (
        <section className="rounded-2xl p-4 text-sm" style={{ background: "var(--loja-card)" }}>
          <label className="flex items-start gap-2">
            <input type="checkbox" checked={aceitou} onChange={(e) => setAceitou(e.target.checked)} className="mt-1" />
            <span>
              Li e aceito os termos de locação
              {config.terms_text ? `: ${config.terms_text.slice(0, 300)}${config.terms_text.length > 300 ? "…" : ""}` : "."}
            </span>
          </label>
          {config.cancellation_text && <p className="mt-2 opacity-70">Cancelamento: {config.cancellation_text}</p>}
          {config.privacy_text && <p className="mt-2 opacity-70">Privacidade: {config.privacy_text}</p>}
        </section>
      )}

      {erro && (
        <p className="rounded-xl border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">
          {erro}
        </p>
      )}

      <button
        type="submit"
        disabled={enviando}
        className="w-full px-4 py-3 text-base font-bold text-white disabled:opacity-60"
        style={{ background: "var(--loja-primary)", borderRadius: "var(--loja-radius)" }}
      >
        {enviando ? "Enviando…" : config.aceitaOrcamento ? "Enviar pedido / solicitar orçamento" : "Enviar solicitação"}
      </button>
      <p className="text-center text-xs opacity-60">
        Ao enviar, você concorda que a locadora analise e responda com a proposta final — valores podem ser ajustados em caso de
        frete pendente ou condição especial.
      </p>
    </form>
  );
}
