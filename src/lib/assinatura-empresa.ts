import "server-only";
import { getDb, run, scalar } from "./db";
import { getSettings } from "./settings";
import { logAction } from "./audit";
import type { SessionUser } from "./auth";
import { removeFileByUrl } from "./uploads";
import { bytesDaAssinatura, MAX_ASSINATURA_BYTES } from "./assinatura";

/**
 * Assinatura digital da empresa.
 *
 * Uma assinatura so, cadastrada pelo administrador em Configuracoes, usada
 * automaticamente em NOVOS contratos e recibos. Vive na tabela `files` (mesmo
 * lugar da logo, dos avatares e das assinaturas dos clientes) e a referencia
 * fica na tabela `settings`, chave `company_signature_file_id` — o mesmo padrao
 * KV de company_logo. Nenhuma tabela nova, nenhuma migration de dados.
 *
 * A assinatura do cliente (fluxo publico /assinar/[token]) nao e tocada: este
 * modulo e independente e so le o que ele exporta (bytesDaAssinatura,
 * MAX_ASSINATURA_BYTES) para reaproveitar a mesma validacao de PNG.
 */

export type AssinaturaEmpresa = {
  /** URL servida pelo /api/arquivo existente, ou null quando nao ha assinatura. */
  url: string;
  file_id: string;
  atualizada_em: string | null;
};

/**
 * Assinatura cadastrada da empresa, ou null quando ainda nao existe.
 *
 * A leitura e barata: uma chave de settings e um scalar. Falta de assinatura
 * nunca e erro — contratos e recibos nascem normalmente, sem o bloco da
 * empresa.
 */
export async function getCompanySignature(): Promise<AssinaturaEmpresa | null> {
  const s = await getSettings();
  const fileId = (s.company_signature_file_id ?? "").trim();
  if (!fileId) return null;
  const criadoEm = await scalar<string | null>(`SELECT created_at FROM files WHERE id = ?`, [fileId]);
  return { url: `/api/arquivo/${fileId}`, file_id: fileId, atualizada_em: criadoEm ?? null };
}

/** Id do arquivo da assinatura atual, para checagens de troca/remocao. */
async function fileIdAtual(): Promise<string | null> {
  const s = await getSettings();
  const fileId = (s.company_signature_file_id ?? "").trim();
  return fileId || null;
}

export type ResultadoSalvamento = { ok: true; fileId: string } | { ok: false; erro: string };

/**
 * Grava (ou substitui) a assinatura da empresa.
 *
 * Recebe o PNG exatamente como o canvas do cliente produz (data URL), passa
 * pela MESMA validacao da assinatura do cliente (formato, cabecalho de bytes e
 * tamanho) e grava na tabela `files`. Substituir descarta o arquivo anterior
 * quando ninguem mais o usa — o mesmo cuidado de logo e avatar.
 *
 * Erro volta como `{ ok: false, erro }`: nada e gravado e o desenho permanece
 * na tela para o usuario tentar de novo sem refazer o traco.
 */
export async function salvarAssinaturaEmpresa(
  dataUrl: string,
  ator: SessionUser,
): Promise<ResultadoSalvamento> {
  const imagem = String(dataUrl ?? "");
  if (!imagem) return { ok: false, erro: "Faça a assinatura antes de confirmar." };
  if (imagem.length > MAX_ASSINATURA_BYTES) {
    return { ok: false, erro: "Assinatura muito pesada. Tente um traço mais simples." };
  }
  const bytes = bytesDaAssinatura(imagem);
  if (!bytes) return { ok: false, erro: "Assinatura inválida." };

  const anterior = await fileIdAtual();

  const fileId = crypto.randomUUID().replace(/-/g, "");
  // INSERT direto na tabela files: o driver aceita Uint8Array em coluna BLOB
  // (mesmo padrao de saveUpload e da assinatura do cliente)
  await getDb()
    .prepare(`INSERT INTO files (id, mime, size, data, created_by) VALUES (?,?,?,?,?)`)
    .bind(fileId, "image/png", bytes.length, bytes, ator.id)
    .run();

  await run(
    `INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ["company_signature_file_id", fileId],
  );

  if (anterior && anterior !== fileId) {
    // removeFileByUrl recebe a URL publica, como o proprio regex dela espera
    await removeFileByUrl(`/api/arquivo/${anterior}`);
  }

  await logAction(
    ator,
    "editar",
    "configuracao",
    null,
    `${ator.name} cadastrou a assinatura digital da empresa`,
  );

  return { ok: true, fileId };
}

/**
 * Remove a assinatura da empresa, quando existe. Contratos e recibos ja gerados
 * nao sao tocados: eles tem copia propria (contract_signatures ou o bloco
 * renderizado no momento da geracao) e nenhum deles aponta para este arquivo.
 */
export async function removerAssinaturaEmpresa(ator: SessionUser): Promise<void> {
  const anterior = await fileIdAtual();
  if (!anterior) return;
  await run(`UPDATE settings SET value = '' WHERE key = 'company_signature_file_id'`);
  await removeFileByUrl(`/api/arquivo/${anterior}`);
  await logAction(
    ator,
    "editar",
    "configuracao",
    null,
    `${ator.name} removeu a assinatura digital da empresa`,
  );
}
