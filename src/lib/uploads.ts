import "server-only";
import { insert, all, one, run, getDb } from "./db";

/**
 * Armazenamento de imagens.
 *
 * O Worker do Cloudflare nao tem sistema de arquivos, entao as imagens ficam
 * no proprio D1 (tabela files) e sao servidas por /api/arquivo/<id>. O que
 * circula pelo resto do sistema continua sendo uma URL, de modo que
 * attachments.path e settings.company_logo nao precisaram mudar.
 */

/** Limite por arquivo. O D1 aceita valores maiores, mas nao compensa. */
const MAX_BYTES = 1_500_000;
const ALLOWED = ["image/jpeg", "image/png", "image/webp", "image/gif"];

/**
 * Formatos aceitos no chat. Executaveis, instaladores e scripts ficam de fora
 * (a lista e fechada — o que nao esta aqui, nao entra), mesmo comprimidos.
 */
const CHAT_ALLOWED = [
  "image/jpeg", "image/png", "image/webp", "image/gif", "image/heic", "image/heif",
  "application/pdf",
  "audio/webm", "audio/ogg", "audio/mpeg", "audio/mp4", "audio/aac", "audio/wav", "audio/x-wav", "audio/mp4a",
  "text/plain", "text/csv", "text/markdown",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/json",
];

/** Extensoes perigosas, bloqueadas mesmo se o mime declarado for aceito. */
const CHAT_FORBIDDEN_EXT = /\.(exe|msi|bat|cmd|com|scr|ps1|sh|js|mjs|jar|apk|dll|vbs|wsf|hta|cpl|pif|gadget|applescript|deb|rpm|dmg|iso|appimage|app|action|workflow|terminal|command|scpt)$/i;

export class UploadError extends Error {}

function randomId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Grava o arquivo enviado e devolve a URL publica, ou null se nao houver arquivo. */
export async function saveUpload(file: File | null, userId?: number): Promise<string | null> {
  if (!file || typeof file === "string" || file.size === 0) return null;

  if (file.size > MAX_BYTES) {
    throw new UploadError(
      `Imagem muito grande (${(file.size / 1024 / 1024).toFixed(1)} MB). O limite e de 1,5 MB.`,
    );
  }
  const mime = (file.type || "image/jpeg").toLowerCase();
  if (!ALLOWED.includes(mime)) {
    throw new UploadError("Formato não suportado. Use JPG, PNG, WEBP ou GIF.");
  }

  const id = randomId();
  const bytes = new Uint8Array(await file.arrayBuffer());

  // o driver do D1 aceita ArrayBuffer/Uint8Array diretamente em colunas BLOB,
  // por isso este INSERT nao passa pelo helper que serializa objetos em JSON
  await getDb()
    .prepare(`INSERT INTO files (id, mime, size, data, created_by) VALUES (?,?,?,?,?)`)
    .bind(id, mime, bytes.length, bytes, userId ?? null)
    .run();

  return `/api/arquivo/${id}`;
}

export type StoredFile = { id: string; mime: string; size: number; data: Uint8Array };

export type ChatSaveOptions = {
  maxBytes?: number;
  /** "audio" exige mime de audio e grava audio_seconds; ausente aceita a lista geral. */
  tipo?: "audio";
  esperado?: string;
  audioSeconds?: number | null;
};

export type ChatSavedFile = {
  id: string;
  name: string;
  mime: string;
  size: number;
  audioSeconds?: number | null;
};

/**
 * Arquivo de chat: mesma tabela `files`, validacao mais larga (pdf, docs,
 * planilhas, audio) e nome preservado pelo remetente. O acesso NAO e publico:
 * a leitura sai por /api/chat/arquivo/<id>, que confere participacao na
 * conversa antes de servir os bytes.
 */
export async function saveChatAttachment(file: File, opts: ChatSaveOptions = {}): Promise<ChatSavedFile> {
  const maxBytes = opts.maxBytes ?? 1_500_000;
  const nome = (file.name || "arquivo").slice(0, 200);
  if (CHAT_FORBIDDEN_EXT.test(nome)) {
    throw new UploadError("Este tipo de arquivo não é permitido no chat por segurança.");
  }
  if (file.size > maxBytes) {
    throw new UploadError(
      `Arquivo muito grande (${(file.size / 1024 / 1024).toFixed(1)} MB). O limite é de ${(maxBytes / 1024 / 1024).toFixed(1).replace(".", ",")} MB.`,
    );
  }
  if (file.size === 0) throw new UploadError("Arquivo vazio ou corrompido.");

  let mime = (file.type || "").toLowerCase().split(";")[0].trim();
  if (opts.tipo === "audio") {
    // Safari grava MP4/AAC, Chrome grava webm/ogg; aceita variacoes do mesmo grupo
    if (!mime.startsWith("audio/")) mime = mime === "video/webm" ? "audio/webm" : mime;
    if (!mime.startsWith("audio/")) throw new UploadError("Formato de áudio não suportado pelo navegador.");
  } else if (!CHAT_ALLOWED.includes(mime)) {
    throw new UploadError("Formato não suportado. Envie imagem, PDF, documento, planilha, texto ou áudio.");
  }

  const id = randomId();
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!bytes.length) throw new UploadError("Arquivo corrompido no upload. Tente novamente.");

  await getDb()
    .prepare(`INSERT INTO files (id, mime, size, data, created_by) VALUES (?,?,?,?,?)`)
    .bind(id, mime, bytes.length, bytes, null)
    .run();
  return { id, name: nome, mime, size: bytes.length, audioSeconds: opts.audioSeconds ?? null };
}

export async function getFileById(id: string): Promise<StoredFile | undefined> {
  return getFile(id);
}

export async function getFile(id: string): Promise<StoredFile | undefined> {
  const row = await one<{ id: string; mime: string; size: number; data: unknown }>(
    `SELECT id, mime, size, data FROM files WHERE id = ?`,
    [id],
  );
  if (!row) return undefined;
  return { id: row.id, mime: row.mime, size: row.size, data: toBytes(row.data) };
}

/**
 * O D1 devolve colunas BLOB como array de numeros. Entregar isso direto ao
 * Response faria o corpo virar o texto "255,216,255,...", ou seja, uma imagem
 * corrompida. Aqui os bytes voltam para Uint8Array, aceitando tambem as demais
 * formas que o driver pode retornar.
 */
function toBytes(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) return Uint8Array.from(data as number[]);
  if (ArrayBuffer.isView(data)) {
    const v = data as ArrayBufferView;
    return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  }
  return new Uint8Array(0);
}

export async function attach(
  entity: string,
  entityId: number,
  files: File[],
  userId?: number,
  caption?: string,
): Promise<number> {
  let saved = 0;
  for (const f of files) {
    const url = await saveUpload(f, userId);
    if (!url) continue;
    await insert(`INSERT INTO attachments (entity, entity_id, path, caption, created_by) VALUES (?,?,?,?,?)`, [
      entity,
      entityId,
      url,
      caption ?? null,
      userId ?? null,
    ]);
    saved++;
  }
  return saved;
}

export async function attachmentsFor(entity: string, entityId: number) {
  return await all<any>(`SELECT * FROM attachments WHERE entity = ? AND entity_id = ? ORDER BY id DESC`, [
    entity,
    entityId,
  ]);
}

export async function removeAttachment(id: number) {
  const a = await one<any>(`SELECT * FROM attachments WHERE id = ?`, [id]);
  if (!a) return;
  await run(`DELETE FROM attachments WHERE id = ?`, [id]);
  await removeFileByUrl(a.path);
}

/** Apaga o arquivo apontado por uma URL /api/arquivo/<id>, se ninguem mais usar. */
export async function removeFileByUrl(url: string | null | undefined) {
  const id = fileIdFromUrl(url);
  if (!id) return;
  const emUso = await all<any>(`SELECT 1 FROM attachments WHERE path = ? LIMIT 1`, [url!]);
  if (emUso.length) return;
  await run(`DELETE FROM files WHERE id = ?`, [id]);
}
export function fileIdFromUrl(url: string | null | undefined): string | null {
  const m = /^\/api\/arquivo\/([0-9a-f]{32})$/.exec(url ?? "");
  return m ? m[1] : null;
}
