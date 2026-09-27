"use client";
import { useRef, useState } from "react";

/**
 * Campo de imagem que reduz a foto antes de enviar.
 *
 * Foto de celular costuma ter varios MB, acima do que vale a pena guardar no
 * banco. Aqui a imagem e redesenhada num canvas com o lado maior limitado e
 * reexportada em JPEG, o que derruba o tamanho para algumas centenas de KB sem
 * perda visivel. O arquivo original nunca chega a subir.
 */
const MAX_LADO = 1600;
const ALVO_BYTES = 900_000;

async function comprimir(file: File): Promise<File> {
  if (!file.type.startsWith("image/")) return file;
  // GIF pode ser animado: recomprimir destruiria a animacao
  if (file.type === "image/gif") return file;

  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return file;

  const escala = Math.min(1, MAX_LADO / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * escala);
  const h = Math.round(bitmap.height * escala);

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return file;
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();

  for (const qualidade of [0.82, 0.7, 0.6, 0.5]) {
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", qualidade));
    if (!blob) break;
    if (blob.size <= ALVO_BYTES || qualidade === 0.5) {
      const nome = file.name.replace(/\.[^.]+$/, "") + ".jpg";
      return new File([blob], nome, { type: "image/jpeg" });
    }
  }
  return file;
}

export default function ImageInput({
  name,
  multiple = false,
  className = "campo",
  capture,
  disabled,
}: {
  name: string;
  multiple?: boolean;
  className?: string;
  capture?: "environment" | "user";
  disabled?: boolean;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<string | null>(null);

  async function onChange() {
    const input = ref.current;
    if (!input?.files?.length) return;

    setStatus("Preparando imagem…");
    try {
      const originais = [...input.files];
      const prontos = await Promise.all(originais.map(comprimir));

      const dt = new DataTransfer();
      for (const f of prontos) dt.items.add(f);
      input.files = dt.files;

      const antes = originais.reduce((s, f) => s + f.size, 0);
      const depois = prontos.reduce((s, f) => s + f.size, 0);
      setStatus(
        depois < antes
          ? `${prontos.length} imagem(ns) prontas (${(depois / 1024).toFixed(0)} KB).`
          : `${prontos.length} imagem(ns) prontas.`,
      );
    } catch {
      setStatus("Não foi possível preparar a imagem. Ela será enviada como está.");
    }
  }

  return (
    <>
      <input
        ref={ref}
        type="file"
        name={name}
        accept="image/*"
        multiple={multiple}
        capture={capture}
        disabled={disabled}
        onChange={onChange}
        className={className}
      />
      {status && <p className="mt-1 text-xs text-stone-500">{status}</p>}
    </>
  );
}
