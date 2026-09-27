"use client";
import { useMemo, useRef, useState } from "react";
import { filtrarOpcoes, type OpcaoSelecionavel } from "@/lib/search-select-utils";

/**
 * Painel de busca dinamica para uma selecao existente.
 *
 * Melhoria da ComboBox, nao um redesign: o <select> original do formulario
 * permanece intacto (mesmo name, mesmas opcoes, validacao e submissao nativas)
 * e este painel entra ao lado dele como um complemento. O usuario abre,
 * digita, e a lista de resultados atualiza a cada tecla; escolher um resultado
 * chama onSelect, que grava o valor no mesmo estado que controla o select.
 *
 * O filtro acontece EM MEMORIA sobre as opcoes que o servidor ja carregou:
 * sincrono por tecla, sem debounce e sem chamada de rede. Sem resposta
 * assincrona nao existe corrida — um resultado antigo nunca sobrescreve um
 * novo. A deduplicacao por id e feita em filtrarOpcoes (search-select-utils),
 * na logica dos dados.
 */
export default function SearchableSelect({
  options,
  onSelect,
  label = "Buscar por nome, CPF ou número",
  semResultado = "Nenhum resultado para o texto digitado.",
  vazio = "Digite para buscar: nome, CPF ou número.",
}: {
  options: OpcaoSelecionavel[];
  /** Grava a escolha no estado que controla o <select> do formulario. */
  onSelect: (value: string) => void;
  /** Placeholder/aria-label do campo de busca. */
  label?: string;
  semResultado?: string;
  vazio?: string;
}) {
  const [aberto, setAberto] = useState(false);
  const [termo, setTermo] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // filtro sincrono e deduplicado; limite de exibicao alto o bastante para
  // listas grandes, com aviso quando cortar
  const resultados = useMemo(() => {
    if (!termo.trim()) return [];
    const t = filtrarOpcoes(options, termo);
    return t.length > LIMITE ? t.slice(0, LIMITE) : t;
  }, [options, termo]);
  const cortados = useMemo(() => {
    if (!termo.trim()) return 0;
    return filtrarOpcoes(options, termo).length - resultados.length;
  }, [options, termo, resultados.length]);

  const escolher = (v: string) => {
    onSelect(v);
    setAberto(false);
    setTermo("");
  };

  if (!aberto) {
    return (
      <button
        type="button"
        onClick={() => {
          setAberto(true);
          // foco automatico assim que abre, para digitar direto
          requestAnimationFrame(() => inputRef.current?.focus());
        }}
        className="shrink-0 whitespace-nowrap rounded-xl border border-nuvem-300 bg-white px-3 text-sm font-semibold text-marca-600"
        aria-expanded={false}
      >
        Buscar
      </button>
    );
  }

  return (
    <div className="w-full rounded-xl border border-nuvem-300 bg-white p-2">
      <div className="flex items-center gap-2">
        <input
          ref={inputRef}
          type="text"
          value={termo}
          onChange={(e) => setTermo(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setAberto(false);
              setTermo("");
            }
          }}
          placeholder={label}
          aria-label={label}
          className="campo py-2 text-sm"
        />
        <button
          type="button"
          onClick={() => {
            setAberto(false);
            setTermo("");
          }}
          className="shrink-0 rounded-lg px-2 py-1 text-xs font-semibold text-stone-500 hover:bg-nuvem-100"
          aria-label="Fechar busca"
        >
          ✕
        </button>
      </div>

      {termo.trim() !== "" && (
        <ul className="mt-2 max-h-64 space-y-0.5 overflow-y-auto">
          {resultados.map((op) => (
            <li key={op.value}>
              <button
                type="button"
                className="w-full rounded-lg px-2.5 py-2 text-left text-sm text-tinta-900 hover:bg-marca-50"
                onMouseDown={(e) => {
                  // mousedown vem antes do blur do input: garante a escolha
                  e.preventDefault();
                  escolher(op.value);
                }}
              >
                {op.label}
              </button>
            </li>
          ))}
          {resultados.length === 0 && <li className="px-2.5 py-2 text-sm text-stone-500">{semResultado}</li>}
          {cortados > 0 && (
            <li className="px-2.5 py-1.5 text-xs text-stone-400">
              Mostrando {resultados.length} de {resultados.length + cortados}. Continue digitando para refinar.
            </li>
          )}
        </ul>
      )}

      {termo.trim() === "" && <p className="mt-1 px-1 text-xs text-stone-400">{vazio}</p>}
    </div>
  );
}

const LIMITE = 30;
