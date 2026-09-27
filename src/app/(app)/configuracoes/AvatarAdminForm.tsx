"use client";
import { useState } from "react";
import Avatar from "@/components/Avatar";
import { SubmitButton } from "@/components/SubmitButton";
import { removeUserAvatarAdmin, saveUserAvatarAdmin } from "./actions";

/**
 * Gestao da foto pelo admin, na lista de usuarios.
 *
 * Mesmo formulario server action (saveUserAvatarAdmin) com input de arquivo
 * proprio: a escolha abre o seletor e o envio substitui a foto anterior,
 * descartando o arquivo antigo quando ninguem mais o usa.
 */
export default function AvatarAdminForm({
  userId,
  userName,
  url,
}: {
  userId: number;
  userName: string;
  url: string | null;
}) {
  const [temArquivo, setTemArquivo] = useState(false);

  return (
    <div className="flex items-center gap-3">
      <Avatar src={url} name={userName} className="h-11 w-11 text-sm" />
      <form action={saveUserAvatarAdmin} className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="id" value={userId} />
        <input
          type="file"
          name="avatar_file"
          accept="image/*"
          className="campo max-w-[13rem] py-1.5 text-xs"
          onChange={(e) => setTemArquivo(!!e.target.files?.length)}
          required
        />
        <SubmitButton variant="secundario" className="px-2.5 py-1.5 text-xs">
          Trocar foto
        </SubmitButton>
        {url && !temArquivo && (
          <SubmitButton
            variant="perigo"
            className="px-2.5 py-1.5 text-xs"
            formAction={removeUserAvatarAdmin}
            confirm={`Remover a foto de ${userName}?`}
          >
            Remover
          </SubmitButton>
        )}
      </form>
    </div>
  );
}
