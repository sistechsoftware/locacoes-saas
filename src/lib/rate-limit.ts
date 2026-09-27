import { run, one } from "./db";

/**
 * Limites de requisicao e leitura segura de corpo, sem depender de sessao.
 *
 * Viviam em api-security.ts junto com a leitura do usuario interno (auth.ts),
 * o que impedia qualquer teste de importar o limitador: auth.ts puxa
 * next/headers e next/navigation, que nao rodam fora do servidor do Next.
 * Separar aqui mantem o mesmo comportamento e deixa o mecanismo reutilizavel
 * pelo portal.
 */
export async function rateLimit(bucket: string, limit: number, seconds = 60) {
  const now = Math.floor(Date.now() / 1000);
  const slot = `${bucket}:${Math.floor(now / seconds)}`;
  await run(`INSERT INTO api_rate_limits(bucket,count,expires_at) VALUES (?,1,?)
    ON CONFLICT(bucket) DO UPDATE SET count=count+1`, [slot, now + seconds * 2]);
  return (await one<{ count: number }>("SELECT count FROM api_rate_limits WHERE bucket=?", [slot]))!.count <= limit;
}

export async function smallJson(request: Request, max = 8192) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error("Corpo vazio.");
  let size = 0, text = "";
  const decoder = new TextDecoder();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) { await reader.cancel(); throw new Error("Requisição muito grande."); }
    text += decoder.decode(value, { stream: true });
  }
  return JSON.parse(text + decoder.decode());
}
