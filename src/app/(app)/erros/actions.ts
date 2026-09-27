"use server";

import { assertAdmin } from "@/lib/auth";
import { marcarResolvido } from "@/lib/error-log";

/**
 * Marca um erro como tratado (ou reabre).
 *
 * Somente admin: a tela /erros e operacional e o risco de um operador esconder
 * um problema real sem criterio existe. Sair da contagem exige decisao
 * consciente, na linha do que o resto do sistema exige para acoes destrutivas.
 */
export async function alternarResolvido(fd: FormData) {
  await assertAdmin();
  const id = Number(fd.get("id"));
  const resolvido = fd.get("resolvido") === "1";
  if (!id) return;
  await marcarResolvido(id, resolvido);
}
