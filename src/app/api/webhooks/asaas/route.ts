import { one, run } from "@/lib/db";
import { processarEventoPayment } from "@/lib/billing";

export const dynamic = "force-dynamic";

/**
 * Webhook do Asaas (Etapa 3).
 *
 * Segurança em três camadas:
 *  1. token compartilhado na URL (?token=) — comparado em tempo constante com
 *     o token resolvido (secret ASAAS_WEBHOOK_TOKEN do Worker, ou o que o
 *     painel /saas cadastrou — ver src/lib/platform-settings.ts);
 *  2. corpo limitado (o Asaas manda JSON pequeno; aborta acima de 256 KB);
 *  3. idempotência: SHA-256 do corpo como UNIQUE em webhook_events — o Asaas
 *     reenvia eventos e cada um é processado no máximo uma vez.
 *
 * Sem token configurado em nenhuma das fontes o endpoint recusa tudo (fail-closed):
 * é melhor perder um evento do que aceitar forjados.
 */

function timingSafeEq(a: string, b: string): boolean {
  const ba = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  if (ba.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ba.length; i++) diff |= ba[i] ^ bb[i];
  return diff === 0;
}

export async function POST(request: Request) {
  const url = new URL(request.url);
  const recebido = url.searchParams.get("token") ?? request.headers.get("asaas-token") ?? "";

  // Token esperado: secret do Worker > cadastro no painel /saas. Sem nada nos
  // dois lugares o endpoint recusa tudo (fail-closed) — melhor perder um evento
  // do que aceitar forjados.
  let esperado: string | null = null;
  try {
    const { credenciaisAsaas } = await import("@/lib/platform-settings");
    esperado = (await credenciaisAsaas()).webhookToken;
  } catch {
    esperado = null;
  }
  if (!esperado || !recebido || !timingSafeEq(recebido, esperado)) {
    return Response.json({ error: "Token inválido." }, { status: 401 });
  }

  const bruto = await request.text();
  if (bruto.length > 262144) {
    return Response.json({ error: "Corpo muito grande." }, { status: 413 });
  }
  let evento: { event?: string; payment?: any } = {};
  try {
    evento = JSON.parse(bruto);
  } catch {
    return Response.json({ error: "JSON inválido." }, { status: 400 });
  }
  const nome = String(evento.event ?? "");
  if (!nome.startsWith("PAYMENT_")) {
    // Reconhecido, mas fora do escopo da etapa (CUSTOMER_*, SUBSCRIPTION_*...).
    return Response.json({ ok: true, ignorado: nome || null });
  }

  const hash = await sha256(bruto);
  const duplicado = await one<{ id: number }>(
    `SELECT id FROM webhook_events WHERE payload_hash = ?`,
    [hash],
  );
  if (duplicado) return Response.json({ ok: true, duplicado: true });

  await run(
    `INSERT INTO webhook_events (event, payload, payload_hash) VALUES (?,?,?)`,
    [nome, bruto, hash],
  );
  try {
    await processarEventoPayment(nome, evento);
    await run(
      `UPDATE webhook_events SET handled = 1, handled_at = datetime('now','localtime')
        WHERE payload_hash = ?`,
      [hash],
    );
  } catch (e: any) {
    await run(
      `UPDATE webhook_events SET error = ? WHERE payload_hash = ?`,
      [String(e?.message ?? e).slice(0, 500), hash],
    ).catch(() => {});
    // 200 com erro registrado: evita loop de retry infinito do Asaas em erros
    // não transitórios; eventos com problema ficam visíveis em webhook_events.
    return Response.json({ ok: false, erro: "registro salvo com falha" });
  }
  return Response.json({ ok: true });
}

async function sha256(texto: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(texto));
  return Array.from(new Uint8Array(bytes)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
