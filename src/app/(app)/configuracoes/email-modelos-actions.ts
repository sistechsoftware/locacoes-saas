"use server";
/**
 * Ações do editor de modelos de e-mail (Configurações > Notificações > E-mails).
 *
 * Uma ação por intenção — salvar, restaurar, pré-visualizar, enviar teste.
 * Antes havia um único formulário com três botões `name="acao"`, e o submitter
 * não é confiável no FormData de uma action: "Pré-visualizar" e "Restaurar"
 * caíam em "salvar" (o campo escondido vencia). Separando as ações, cada botão
 * tem um comportamento só, e a prévia recebe o RASCUNHO da tela como argumento.
 *
 * Segurança:
 *  * TODA ação exige `assertAdmin()` e grava pelo `setSettings`, que é escopado
 *    pela empresa da SESSÃO. Não há company_id vindo do formulário — uma empresa
 *    não alcança o modelo de outra nem forjando o campo.
 *  * A validação roda no servidor (limites de tamanho + variáveis do contexto),
 *    e o modelo vindo da tela é reconstruído campo a campo (nada de objeto cru).
 *  * Nada aqui enfileira e-mail: a pré-visualização é somente leitura e o envio
 *    de teste vai direto ao provedor com dados fictícios, sem passar pela fila
 *    (`agendarEmail`) e sem tocar em reserva, pagamento ou operação.
 */
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { assertAdmin } from "@/lib/auth";
import { logAction } from "@/lib/audit";
import { insert } from "@/lib/db";
import { setSettings } from "@/lib/settings";
import { emailValido, normalizarEmail } from "@/lib/identidade";
import { enviarEmailDetalhado, publicUrlDaPlataforma } from "@/lib/email";
import { identidadeDaEmpresa } from "@/lib/email-dados";
import { renderizarPreviaModelo } from "@/lib/email-preview";
import {
  CAMPOS_MODELO,
  chaveModelo,
  serializarModelo,
  validarModelo,
  type CampoModelo,
  type ModeloEmail,
} from "@/lib/email-modelos";
import { TIPOS_EMAIL, type TipoEmail } from "@/lib/email-notificacoes";
import { chavesDoTipo, chavesInvalidas } from "@/lib/email-variaveis";

export type ResultadoModeloAcao = {
  ok: boolean;
  erro?: string;
  mensagem?: string;
  html?: string;
  assunto?: string;
};

/** Nomes dos campos no formulário: `modelo_assunto`, `modelo_corpo`… */
const campoForm = (campo: CampoModelo) => `modelo_${campo}`;

function tipoDoFormulario(fd: FormData): TipoEmail | null {
  const tipo = String(fd.get("tipo") ?? "").trim() as TipoEmail;
  return tipo in TIPOS_EMAIL ? tipo : null;
}

function tipoValido(tipo: unknown): TipoEmail | null {
  const t = String(tipo ?? "").trim() as TipoEmail;
  return t in TIPOS_EMAIL ? t : null;
}

function modeloDoFormulario(fd: FormData): ModeloEmail {
  const out: ModeloEmail = {};
  for (const campo of CAMPOS_MODELO) {
    const valor = String(fd.get(campoForm(campo.chave)) ?? "");
    if (valor.trim()) out[campo.chave] = valor;
  }
  return out;
}

/**
 * Modelo vindo da prévia: chega como ARGUMENTO da action, então é reconstruído
 * campo a campo — objeto do cliente nunca entra direto, e o tamanho é limitado.
 */
function modeloDoCliente(bruto: unknown): ModeloEmail {
  const out: ModeloEmail = {};
  if (!bruto || typeof bruto !== "object") return out;
  const obj = bruto as Record<string, unknown>;
  for (const campo of CAMPOS_MODELO) {
    const valor = obj[campo.chave];
    if (typeof valor === "string" && valor.trim()) out[campo.chave] = valor.slice(0, campo.max);
  }
  return out;
}

/** Variáveis escritas que o contexto deste aviso não sabe preencher. */
function invalidasDoModelo(tipo: TipoEmail, modelo: ModeloEmail): string[] {
  const texto = CAMPOS_MODELO.map((c) => modelo[c.chave] ?? "").join("\n");
  return chavesInvalidas(texto, chavesDoTipo(tipo));
}

/**
 * Origem pública para a logo.
 *
 * Em produção é a var PUBLIC_URL. No desenvolvimento local ela é vazia, e sem
 * origem a logo vira caminho relativo — que o cliente de e-mail não resolve e o
 * iframe da prévia também não. Aí usamos o host da própria requisição, que é
 * exatamente onde a tela está aberta.
 */
async function origemPublica(): Promise<string> {
  const publica = (await publicUrlDaPlataforma()).trim();
  if (publica) return publica;
  try {
    const h = await headers();
    const host = (h.get("x-forwarded-host") ?? h.get("host") ?? "").split(",")[0].trim();
    if (!host) return "";
    const proto =
      (h.get("x-forwarded-proto") ?? "").split(",")[0].trim() ||
      (/^(localhost|127\.|\[::1\])/.test(host) ? "http" : "https");
    return `${proto}://${host}`;
  } catch {
    return "";
  }
}

/** Salvar o modelo em edição (texto vazio = usar o original naquele campo). */
export async function salvarModeloEmailAction(
  _prev: ResultadoModeloAcao | null,
  fd: FormData,
): Promise<ResultadoModeloAcao> {
  const user = await assertAdmin();
  const tipo = tipoDoFormulario(fd);
  if (!tipo) return { ok: false, erro: "Tipo de e-mail desconhecido." };

  const modelo = modeloDoFormulario(fd);
  const erro = validarModelo(modelo);
  if (erro) return { ok: false, erro };

  const invalidas = invalidasDoModelo(tipo, modelo);
  if (invalidas.length) {
    return {
      ok: false,
      erro: `Estas variáveis não existem neste aviso: ${invalidas.map((v) => `{{${v}}}`).join(", ")}. Remova-as ou escolha uma da lista.`,
    };
  }

  await setSettings({ [chaveModelo(tipo)]: serializarModelo(modelo) });
  await logAction(
    user,
    "editar",
    "configuracao",
    null,
    `${user.name} personalizou o modelo de e-mail ${TIPOS_EMAIL[tipo].rotulo}`,
  );
  revalidatePath("/configuracoes");
  revalidatePath("/configuracoes/emails-modelos");

  return { ok: true, mensagem: "Modelo salvo. Os próximos envios já usam este texto." };
}

/** Restaurar o texto original do aviso (grava vazio). */
export async function restaurarModeloEmailAction(tipoRecebido: TipoEmail): Promise<ResultadoModeloAcao> {
  const user = await assertAdmin();
  const tipo = tipoValido(tipoRecebido);
  if (!tipo) return { ok: false, erro: "Tipo de e-mail desconhecido." };

  await setSettings({ [chaveModelo(tipo)]: "" });
  await logAction(
    user,
    "editar",
    "configuracao",
    null,
    `${user.name} restaurou o modelo original de e-mail ${TIPOS_EMAIL[tipo].rotulo}`,
  );
  revalidatePath("/configuracoes");
  revalidatePath("/configuracoes/emails-modelos");

  return { ok: true, mensagem: "Modelo original restaurado. Os próximos envios voltam ao texto padrão." };
}

/**
 * Pré-visualização do RASCUNHO: não grava nada e não enfileira nada. Pode ser
 * feita com o texto ainda em edição, inclusive com variável indisponível (que
 * aparece vazia, como sairia no envio) — a tela já avisa antes.
 */
export async function previaModeloEmailAction(
  tipoRecebido: TipoEmail,
  modeloRecebido: ModeloEmail,
  reservaId: number | null,
): Promise<ResultadoModeloAcao> {
  const user = await assertAdmin();
  const tipo = tipoValido(tipoRecebido);
  if (!tipo) return { ok: false, erro: "Tipo de e-mail desconhecido." };

  const modelo = modeloDoCliente(modeloRecebido);
  const reserva = Number(reservaId);

  try {
    const m = await renderizarPreviaModelo({
      companyId: user.company_id,
      tipo,
      modelo,
      reservaId: Number.isFinite(reserva) && reserva > 0 ? reserva : null,
      baseUrl: await origemPublica(),
    });
    return { ok: true, html: m.html, assunto: m.assunto, mensagem: "Prévia gerada — nenhum e-mail foi enviado." };
  } catch (e) {
    console.error("[email] falha ao montar prévia de modelo:", (e as Error)?.message ?? e);
    return { ok: false, erro: "Não foi possível montar a prévia deste modelo." };
  }
}

/**
 * Envio de TESTE do modelo em edição.
 *
 * Usa dados fictícios e vai direto ao provedor: NÃO passa pela fila, então não
 * existe risco de disparar aviso real de reserva, pagamento ou operação. O
 * registro no histórico nasce como `email_teste`, que nunca é reprocessado.
 */
export async function enviarModeloTesteAction(
  _prev: ResultadoModeloAcao | null,
  fd: FormData,
): Promise<ResultadoModeloAcao> {
  const user = await assertAdmin();
  const tipo = tipoDoFormulario(fd);
  if (!tipo) return { ok: false, erro: "Tipo de e-mail desconhecido." };

  const destino = normalizarEmail(fd.get("destino"));
  if (!emailValido(destino)) return { ok: false, erro: "Informe um e-mail válido para receber o teste." };

  const modelo = modeloDoFormulario(fd);
  const ident = await identidadeDaEmpresa(user.company_id, { baseUrl: await origemPublica() });

  let montado;
  try {
    // reserva_id NÃO é usado aqui: o teste nunca lê dados de um cliente real.
    montado = await renderizarPreviaModelo({
      companyId: user.company_id,
      tipo,
      modelo,
      baseUrl: await origemPublica(),
    });
  } catch (e) {
    console.error("[email] falha ao montar modelo de teste:", (e as Error)?.message ?? e);
    return { ok: false, erro: "Não foi possível montar o e-mail de teste." };
  }

  const r = await enviarEmailDetalhado({
    to: destino,
    subject: montado.assunto,
    html: montado.html,
    text: montado.texto,
    deNome: ident.nome,
  });

  const agora = Math.floor(Date.now() / 1000);
  const status = r.ok
    ? "enviado"
    : r.motivoConfig
      ? "ignorado"
      : r.temporaria
        ? "falha_temporaria"
        : "falha_definitiva";
  await insert(
    `INSERT INTO email_notifications
       (company_id, type, source, source_id, context, recipient, subject, status, motivo,
        scheduled_at, next_attempt, attempts, last_error, provider_id, sent_at, created_at, updated_at, dedupe_key)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      user.company_id,
      "email_teste",
      "configuracao",
      null,
      "{}",
      destino,
      montado.assunto,
      status,
      r.motivoConfig ? "provedor_sem_configuracao" : null,
      agora,
      agora,
      r.ok ? 1 : 0,
      r.ok ? null : String(r.motivoConfig ?? r.erro ?? "").slice(0, 300),
      r.id,
      r.ok ? agora : null,
      agora,
      agora,
      `c${user.company_id}:email_teste:${agora}:${Math.random().toString(36).slice(2, 8)}`,
    ],
  );
  await logAction(user, "editar", "configuracao", null, `${user.name} enviou um e-mail de teste do modelo (${status})`);

  if (r.ok) return { ok: true, mensagem: `E-mail de teste enviado para ${destino}. Nenhum aviso real foi disparado.` };

  const motivo = r.motivoConfig
    ? "Provedor não configurado no Worker (RESEND_API_KEY / RESEND_FROM)."
    : `Falha no envio: ${String(r.erro ?? "erro desconhecido").slice(0, 200)}`;
  return { ok: false, erro: motivo };
}
