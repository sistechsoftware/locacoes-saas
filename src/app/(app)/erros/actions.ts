"use server";

import { assertPlatformAdmin, assertAdmin } from "@/lib/auth";
import { marcarResolvido } from "@/lib/error-log";

/**
 * Marca um erro como tratado (ou reabre).
 *
 * Somente admin: a tela /erros e operacional e o risco de um operador esconder
 * um problema real sem criterio existe. O administrador da EMPRESA só afeta os
 * erros da própria empresa; erros globais são do operador da plataforma.
 */
export async function alternarResolvido(fd: FormData) {
  const admin = await assertAdmin();
  const id = Number(fd.get("id"));
  const resolvido = fd.get("resolvido") === "1";
  if (!id) return;
  // platform_admin enxerga a visão global; admin de empresa, só a sua.
  if (admin.platform_admin) {
    await marcarResolvido(id, resolvido, null);
  } else {
    await marcarResolvido(id, resolvido, admin.company_id);
  }
}
