"use client";
import { useState, useTransition } from "react";
import { salvarContatoSuporteAction } from "../actions";

/**
 * Cadastro do CANAL DE SUPORTE da plataforma (e-mail e WhatsApp).
 *
 * Valores não-sensíveis de propósito: eles aparecem na tela de assinatura
 * BLOQUEADA — justamente quando o cliente não consegue entrar no sistema e
 * precisa de ajuda. Por isso o campo nasce preenchido (ao contrário das
 * credenciais do Asaas) e pode ser apagado com "Apagar".
 */
export default function FormSuporte({ email, whatsapp }: { email: string; whatsapp: string }) {
  const [novoEmail, setNovoEmail] = useState(email);
  const [novoWhats, setNovoWhats] = useState(whatsapp);
  const [msg, setMsg] = useState<{ ok: boolean; texto: string } | null>(null);
  const [pendente, start] = useTransition();

  function salvar() {
    setMsg(null);
    start(async () => {
      const r = await salvarContatoSuporteAction({
        suporte_email: novoEmail,
        suporte_whatsapp: novoWhats,
      });
      setMsg({ ok: r.ok, texto: r.mensagem });
    });
  }

  function apagar() {
    setMsg(null);
    start(async () => {
      const limpar = [
        ...(email ? (["suporte_email"] as const) : []),
        ...(whatsapp ? (["suporte_whatsapp"] as const) : []),
      ];
      const r = await salvarContatoSuporteAction({}, [...limpar]);
      setMsg({ ok: r.ok, texto: r.mensagem });
      if (r.ok) {
        setNovoEmail("");
        setNovoWhats("");
      }
    });
  }

  return (
    <div className="mt-3 space-y-3">
      <div>
        <label className="rotulo">E-mail do suporte</label>
        <input
          type="email"
          className="campo"
          value={novoEmail}
          onChange={(e) => setNovoEmail(e.target.value)}
          placeholder="suporte@sualoja.com.br"
        />
      </div>
      <div>
        <label className="rotulo">WhatsApp do suporte (com DDD e código do país)</label>
        <input
          className="campo"
          value={novoWhats}
          onChange={(e) => setNovoWhats(e.target.value)}
          placeholder="+55 31 99999-0000"
          inputMode="tel"
        />
        <p className="mt-1 text-xs text-stone-500">
          Gravado só com dígitos. É este contato que aparece para a empresa com assinatura bloqueada.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={salvar}
          disabled={pendente}
          className="rounded-lg bg-marca-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-marca-700 disabled:opacity-60"
        >
          {pendente ? "Salvando…" : "Salvar contato"}
        </button>
        {(email || whatsapp) && (
          <button
            onClick={apagar}
            disabled={pendente}
            className="rounded-lg border border-stone-300 px-3 py-1.5 text-xs font-semibold text-stone-700 hover:bg-stone-50 disabled:opacity-60"
          >
            Apagar
          </button>
        )}
        {msg && (
          <span className={`text-xs font-semibold ${msg.ok ? "text-green-700" : "text-red-700"}`}>{msg.texto}</span>
        )}
      </div>
    </div>
  );
}
