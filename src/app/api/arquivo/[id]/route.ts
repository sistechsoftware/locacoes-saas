import { currentUser } from "@/lib/auth";
import { canView, ehAdmin, type Module } from "@/lib/roles";
import { getFile } from "@/lib/uploads";
import { one } from "@/lib/db";

const HEX32 = /^[0-9a-f]{32}$/;

function resposta(file: { mime: string; data: Uint8Array }, cache: string) {
  const corpo = file.data.buffer.slice(
    file.data.byteOffset,
    file.data.byteOffset + file.data.byteLength,
  ) as ArrayBuffer;
  return new Response(corpo, {
    headers: {
      "Content-Type": file.mime,
      "Content-Length": String(corpo.byteLength),
      "Cache-Control": cache,
    },
  });
}

/**
 * Arquivo protegido por sessão (a antiga rota pública virou autenticada).
 *
 * Barreiras, nesta ordem:
 *  1. sessão válida (401 sem ela);
 *  2. o arquivo TEM que pertencer à empresa do usuário (404 caso contrário) —
 *     id existente de outra empresa é indistinguível de inexistente;
 *  3. autorização fina por tipo de arquivo: avatar (próprio/admin), chat
 *     (participação na conversa) e demais pelo módulo correspondente.
 *
 * O que é genuinamente público (logo da empresa) tem rota própria:
 * /api/publico/arquivo/[id].
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return new Response("Não autenticado.", { status: 401 });

  const { id } = await params;
  if (!HEX32.test(id)) return new Response("Not found", { status: 404 });

  const file = await getFile(id);
  if (!file || (file as any).company_id !== user.company_id) {
    return new Response("Not found", { status: 404 });
  }

  // Avatar: o próprio usuário sempre; outro usuário só com papel admin/owner
  // da MESMA empresa.
  const avatar = await one<{ id: number; company_id: number }>(
    `SELECT id, company_id FROM users WHERE avatar_url = ?`,
    [ `/api/arquivo/${id}` ],
  );
  if (avatar && (avatar.id === user.id || (avatar.company_id === user.company_id && ehAdmin(user.role)))) {
    return resposta(file, "private, max-age=86400");
  }

  // Chat: só participantes da conversa leem o anexo.
  const chat = await one<{ n: number }>(
    `SELECT 1 AS n FROM chat_messages m
       JOIN chat_participants p ON p.conversation_id = m.conversation_id
      WHERE m.file_id = ? AND p.user_id = ?`,
    [id, user.id],
  );
  if (chat) return resposta(file, "private, no-store");

  // Classificação por módulo: o papel precisa poder VER o módulo dono.
  const modulo = await classificarModulo(id, user.company_id);
  if (modulo && !canView(user.role, modulo)) {
    return new Response("Not found", { status: 404 });
  }
  // Logo da empresa: exibida em todo o sistema para quem está logado.
  const ehLogo = await one<{ n: number }>(
    `SELECT 1 AS n FROM company_settings
      WHERE company_id = ? AND key = 'company_logo' AND value IN (?, ?)`,
    [user.company_id, `/api/arquivo/${id}`, `/api/publico/arquivo/${id}`],
  );
  if (ehLogo) return resposta(file, "private, max-age=86400");

  return resposta(file, "private, max-age=3600");
}

/** Descobre o módulo dono do arquivo para checar permissão do papel. */
async function classificarModulo(id: string, companyId: number): Promise<Module | null> {
  const checks: { sql: string; params: any[]; modulo: Module }[] = [
    { sql: `SELECT 1 AS ok FROM products WHERE photo = ? AND company_id = ?`, params: [`/api/arquivo/${id}`, companyId], modulo: "produtos" },
    { sql: `SELECT 1 AS ok FROM product_units WHERE photo = ? AND company_id = ?`, params: [`/api/arquivo/${id}`, companyId], modulo: "estoque" },
    { sql: `SELECT 1 AS ok FROM damage_reports WHERE photo = ? AND company_id = ?`, params: [`/api/arquivo/${id}`, companyId], modulo: "estoque" },
    { sql: `SELECT 1 AS ok FROM contract_signatures WHERE signature_file_id = ? AND company_id = ?`, params: [id, companyId], modulo: "contratos" },
    { sql: `SELECT 1 AS ok FROM customer_documents WHERE file_id = ? AND company_id = ?`, params: [id, companyId], modulo: "contratos" },
    { sql: `SELECT 1 AS ok FROM attachments WHERE path = ? AND company_id = ?`, params: [`/api/arquivo/${id}`, companyId], modulo: "operacao" },
  ];
  for (const c of checks) {
    if (await one<{ ok: number }>(c.sql, c.params)) return c.modulo;
  }
  // Anexo sem classificação conhecida: qualquer papel da própria empresa lê
  // (o isolamento INTER-empresa já está garantido acima).
  return null;
}
