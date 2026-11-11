"use client";

import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";
import { centavosDoTexto, textoMoeda, valorParaCampo } from "@/lib/money-input";

export type MoneyInputProps = {
  /** Nome enviado no FormData. O campo visível não tem nome: um input oculto
   *  leva o valor decimal ("1234.56"), exatamente o formato de antes. */
  name?: string;
  /** Valor controlado, em centavos. null = vazio. */
  valueCents?: number | null;
  /** Valor inicial, em centavos (campo não controlado). */
  defaultCents?: number | null;
  /** Novo valor em centavos a cada digitação; null = campo apagado. */
  onCentsChange?: (cents: number | null) => void;
  /** Permite valores negativos (ex.: saldo inicial de conta). */
  allowNegative?: boolean;
  className?: string;
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
  readOnly?: boolean;
  id?: string;
  autoFocus?: boolean;
  "aria-label"?: string;
  onBlur?: () => void;
};

/**
 * Campo de valor monetário com máscara automática no padrão brasileiro.
 *
 * A máscara é só visual: o estado e o envio continuam em centavos/decimal, então
 * cálculos, banco e APIs permanecem idênticos. O dígito entra sempre pela
 * direita (calculadora) e o cursor fica no fim do texto, sem saltos — a
 * formatação nunca move o valor armazenado.
 */
export default function MoneyInput({
  name,
  valueCents,
  defaultCents = null,
  onCentsChange,
  allowNegative = false,
  className = "campo",
  placeholder = "R$ 0,00",
  required = false,
  disabled = false,
  readOnly = false,
  id,
  autoFocus = false,
  "aria-label": ariaLabel,
  onBlur,
}: MoneyInputProps) {
  const controlado = valueCents !== undefined;
  const [interno, setInterno] = useState<number | null>(defaultCents ?? null);
  const cents = controlado ? (valueCents ?? null) : interno;
  const ref = useRef<HTMLInputElement>(null);

  function aplicar(proximo: number | null) {
    if (!controlado) setInterno(proximo);
    onCentsChange?.(proximo);
  }

  function aoDigitar(e: ChangeEvent<HTMLInputElement>) {
    aplicar(centavosDoTexto(e.target.value, { permitirNegativo: allowNegative }));
  }

  /* Delete no fim da máscara se comporta como Backspace: remove o último
   * dígito. Sem isso, apagar com Delete não teria efeito visível porque o
   * cursor fica sempre no fim do texto formatado. */
  function aoTeclar(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key !== "Delete" || disabled || readOnly) return;
    const el = e.currentTarget;
    if (el.selectionStart !== el.selectionEnd || el.selectionEnd !== el.value.length) return;
    if (cents === null) return;
    e.preventDefault();
    const digitos = String(Math.abs(cents)).slice(0, -1);
    const sinal = allowNegative && cents < 0 ? "-" : "";
    aplicar(centavosDoTexto(sinal + digitos, { permitirNegativo: allowNegative }));
  }

  /* Cursor sempre no fim: digitar/colar nunca deixa o cursor perdido no meio
   * dos separadores de milhar. */
  useEffect(() => {
    const el = ref.current;
    if (!el || document.activeElement !== el) return;
    const fim = el.value.length;
    if (el.selectionStart !== fim || el.selectionEnd !== fim) el.setSelectionRange(fim, fim);
  });

  return (
    <>
      <input
        ref={ref}
        type="text"
        inputMode="decimal"
        autoComplete="off"
        value={textoMoeda(cents)}
        onChange={aoDigitar}
        onKeyDown={aoTeclar}
        onBlur={onBlur}
        placeholder={placeholder}
        required={required}
        disabled={disabled}
        readOnly={readOnly}
        id={id}
        autoFocus={autoFocus}
        aria-label={ariaLabel}
        className={className}
      />
      {name ? <input type="hidden" name={name} value={valorParaCampo(cents)} /> : null}
    </>
  );
}
