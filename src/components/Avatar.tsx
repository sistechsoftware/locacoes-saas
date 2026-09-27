"use client";

import { useState } from "react";
import { initials } from "@/lib/format";

/**
 * Avatar de usuario.
 *
 * Mostra a foto quando existe e cai para o circulo de iniciais quando nao
 * tem — o mesmo visual que o chat ja usava, entao quem nao tem foto nao deixa
 * espaco vazio nem muda o layout. Um erro de carregamento (404, rede) volta
 * para as iniciais em vez de deixar a imagem quebrada. Fundo neutro fixo
 * evita pisca de layout enquanto a foto carrega.
 */
export default function Avatar({
  src,
  name,
  className = "h-10 w-10 text-sm",
  bg,
}: {
  src: string | null | undefined;
  name: string;
  className?: string;
  /** Classes do circulo sem foto; herdadas quando omitido. */
  bg?: string;
}) {
  const [falhou, setFalhou] = useState(false);
  const mostrar = !!src && !falhou;
  return mostrar ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={name}
      onError={() => setFalhou(true)}
      className={`shrink-0 rounded-full object-cover ${className}`}
    />
  ) : (
    <span
      className={`flex shrink-0 items-center justify-center rounded-full font-bold ${className} ${bg ?? "bg-nuvem-200 text-tinta-700"}`}
      aria-hidden="true"
    >
      {initials(name)}
    </span>
  );
}
