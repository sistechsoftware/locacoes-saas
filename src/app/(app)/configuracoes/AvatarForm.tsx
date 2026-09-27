"use client";
import { useActionState } from "react";
import { useRef, useState } from "react";
import Avatar from "@/components/Avatar";
import { SubmitButton } from "@/components/SubmitButton";
import { removeMyAvatar, saveMyAvatar } from "./actions";

const LIMITE = 1_500_000;

/**
 * Foto de perfil propria ("Minha conta").
 *
 * A compressao roda no navegador (mesma rotina do ImageInput): a foto do
 * celular sai de varios MB para algumas centenas de KB antes de subir, e o
 * arquivo original nem chega ao servidor.
 */
export default function AvatarForm({ url, name }: { url: string | null; name: string }) {
  const [erro, action] = useActionState(saveMyAvatar, null);
  const [msg, setMsg] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(url);

  function escolher() {
    const input = inputRef.current;
    if (!input?.files?.length) return;
    const file = input.files[0];
    if (!file.type.startsWith("image/")) {
      setMsg("Formato não suportado. Use JPG, PNG, WEBP ou GIF.");
      input.value = "";
      return;
    }
    setMsg(null);
    setPreview(URL.createObjectURL(file));
    // o formulario envia o proprio input; nada a fazer aqui alem do preview
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-4">
        <Avatar src={preview} name={name} className="h-16 w-16 text-lg" />
        <div className="min-w-0">
          <p className="text-sm font-semibold text-tinta-900">{name}</p>
          <p className="text-xs text-stone-500">JPG, PNG, WEBP ou GIF · até 1,5 MB (a foto é reduzida antes de enviar)</p>
        </div>
      </div>
      <form action={action} className="flex flex-wrap items-center gap-2">
        <input
          ref={inputRef}
          type="file"
          name="avatar_file"
          accept="image/*"
          className="campo max-w-xs"
          onChange={escolher}
          required
        />
        <SubmitButton variant="secundario">Salvar foto</SubmitButton>
        {url && (
          <SubmitButton
            variant="perigo"
            formAction={removeMyAvatar}
            confirm="Remover sua foto de perfil?"
          >
            Remover
          </SubmitButton>
        )}
      </form>
      {erro && <p className="text-sm font-medium text-red-700">{erro}</p>}
      {msg && <p className="text-sm font-medium text-amber-700">{msg}</p>}
    </div>
  );
}
