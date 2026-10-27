"use server";
import { preparationValue } from "@/lib/availability-time";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { insert, one, run, scalar } from "@/lib/db";
import { assertAdmin, hashPassword, requireModuleEdit, requireUser, verifyPassword, type SessionUser } from "@/lib/auth";
import { ehAdmin } from "@/lib/roles";
import { podeCriarUsuario } from "@/lib/billing";
import { atualizarUsuario, criarUsuario, excluirUsuario, alternarStatusUsuario } from "@/lib/usuarios";
import { getSettings, setSettings } from "@/lib/settings";
import { espelharDadosEmpresa } from "@/lib/espelho-empresa";
import { resolverOperacao, validarOperacaoForm } from "@/lib/operacao";
import { normalizarUnidade } from "@/lib/fidelidade";
import { restaurarOperacaoConfig, salvarOperacaoConfig } from "@/lib/operacao-db";
import { contractUsesHtml, sanitizeContractHtml } from "@/lib/contract-html";
import { validarDimensoesRecibo } from "@/lib/recibo-visual";
import { resolverNavLayout } from "@/lib/nav";

/**
 * Layout de navegacao (Configuracoes > Navegacao): "classico" (menu plano de
 * sempre) ou "agrupado" (grupos conceituais — ver src/lib/nav.ts). Nao e
 * permissao nem dado de negocio: e uma preferencia visual da empresa, guarda
 * em company_settings como os demais ajustes (escopo: empresa da SESSAO via
 * setSettings) e vale para todo mundo da empresa. A validacao roda aqui no
 * servidor (resolverNavLayout e a mesma funcao que os testes travam).
 */
export async function saveNavLayout(fd: FormData) {
  const user = await assertAdmin();
  const layout = resolverNavLayout(fd.get("nav_layout"));
  await setSettings({ nav_layout: layout });
  await logAction(user, "editar", "configuracao", null, `${user.name} alternou o layout de navegacao para ${layout}`);
  /*
   * Mesmo precedente do saveOperacaoSettings: NADA de revalidatePath("/",
   * "layout") — invalidar o layout inteiro forçava o cliente a refazer a
   * navegação toda. O shell do (app) é force-dynamic e lê o banco a cada
   * request, então o novo layout aparece na próxima navegação sem qualquer
   * invalidação global.
   */
  revalidatePath("/configuracoes");
}

export async function saveStockSettings(fd: FormData) {
  const user = await assertAdmin();
  let minutes: number;
  try { minutes = preparationValue(fd.get("stock_preparation_minutes")); }
  catch (e) { redirect(`/configuracoes?aba=disponibilidade&erro=${encodeURIComponent((e as Error).message)}`); }
  await setSettings({ stock_preparation_minutes: String(minutes) });
  await logAction(user, "editar", "configuracao", null, `${user.name} configurou ${minutes} minutos de preparacao do estoque`);
  revalidatePath("/", "layout");
}
import { logAction } from "@/lib/audit";
import { saveUpload, UploadError, removeFileByUrl } from "@/lib/uploads";
import { parseMoney } from "@/lib/format";
import { salvarAssinaturaEmpresa, removerAssinaturaEmpresa } from "@/lib/assinatura-empresa";
import { documentoDoTipo, emailValido, normalizarEmail, tipoPessoaValido } from "@/lib/identidade";
import { antecedenciasValidas, corValida, horaValida, MAX_ANTECEDENCIAS } from "@/lib/email-notificacoes";
import { fusoValido } from "@/lib/email-tempo";
import { identidadeDaEmpresa } from "@/lib/email-dados";
import { emailTeste } from "@/lib/email-templates";
import { enviarEmailDetalhado } from "@/lib/email";
import { documentoJaUsado, emailJaUsado } from "@/lib/contas";

export async function saveCompanySettings(fd: FormData): Promise<void> {
  const user = await assertAdmin();
  const logoFile = fd.get("logo_file");
  let logoPath: string | null = null;
  if (logoFile instanceof File && logoFile.size > 0) {
    try {
      logoPath = await saveUpload(logoFile, user.id);
    } catch (e) {
      const motivo = e instanceof UploadError ? e.message : "Não foi possível salvar a imagem.";
      redirect(`/configuracoes?aba=empresa&erro=${encodeURIComponent(motivo)}`);
    }
  }

  const values: Record<string, string> = {
    company_name: String(fd.get("company_name") ?? "").trim(),
    company_tagline: String(fd.get("company_tagline") ?? "").trim(),
    company_doc: String(fd.get("company_doc") ?? "").trim(),
    company_phone: String(fd.get("company_phone") ?? "").trim(),
    company_whatsapp: String(fd.get("company_whatsapp") ?? "").trim(),
    company_email: String(fd.get("company_email") ?? "").trim(),
    company_address: String(fd.get("company_address") ?? "").trim(),
    company_city: String(fd.get("company_city") ?? "").trim(),
    pix_key: String(fd.get("pix_key") ?? "").trim(),
    bank_info: String(fd.get("bank_info") ?? "").trim(),
    default_deposit_cents: String(parseMoney(String(fd.get("default_deposit") ?? ""))),
    // Modalidade padrão de cobrança: só valores conhecidos; lixo vira 'fixo'.
    pricing_default_mode: String(fd.get("pricing_default_mode") ?? "") === "diaria" ? "diaria" : "fixo",
    // Hora extra da extensão de retirada: preço em centavos, limite com mínimo 1.
    extra_hour_price_cents: String(parseMoney(String(fd.get("extra_hour_price") ?? ""))),
    extra_hours_until_daily: String(Math.max(1, Math.round(Number(fd.get("extra_hours_until_daily")) || 6))),
  };
  if (logoPath) {
    // troca a logo e descarta a anterior, para nao acumular arquivo orfao
    const anterior = (await getSettings()).company_logo;
    values.company_logo = logoPath;
    if (anterior && anterior !== logoPath) await removeFileByUrl(anterior);
  }

  await setSettings(values);
  /**
   * Espelho COMPLETO no cadastro da empresa (companies): nome, documento,
   * e-mail, telefone, whatsapp, endereço e cidade acompanham o que a tela
   * acabou de salvar. A cobrança (Asaas), o painel SaaS e a sessão leem
   * companies — sem este espelho, renomear a empresa mudava só o KV e o
   * cadastro comercial ficava para sempre com o nome do onboarding.
   * A regra de sobrescrita de cada coluna (e a proteção do que o onboarding
   * gravou) vive em lib/espelho-empresa.ts; documento sai só com dígitos.
   */
  await espelharDadosEmpresa(user.company_id, {
    name: values.company_name,
    document: values.company_doc,
    email: values.company_email,
    phone: values.company_phone,
    whatsapp: values.company_whatsapp,
    address: values.company_address,
    city: values.company_city,
  });
  await logAction(user, "editar", "configuracao", null, `${user.name} atualizou os dados da empresa`);
  revalidatePath("/configuracoes");
  revalidatePath("/dashboard", "layout");
}

export async function saveTemplates(fd: FormData) {
  const user = await assertAdmin();
  /**
   * Modelo formatado (HTML vindo do editor) e sanitizado aqui, no servidor:
   * a barreira de seguranca nunca depende do navegador. Modelo em texto puro
   * e guardado exatamente como chegou, sem transformacao nenhuma.
   */
  const modeloBruto = String(fd.get("contract_template") ?? "");
  const contract_template = contractUsesHtml(modeloBruto) ? sanitizeContractHtml(modeloBruto) : modeloBruto;
  /*
   * Modelo digital: mesma barreira de seguranca do impresso, salvamento
   * independente — editar um modelo nao altera o outro.
   */
  const modeloBrutoDigital = String(fd.get("contract_template_digital") ?? "");
  const contract_template_digital = contractUsesHtml(modeloBrutoDigital)
    ? sanitizeContractHtml(modeloBrutoDigital)
    : modeloBrutoDigital;
  const values: Record<string, string> = {
    wa_confirm: String(fd.get("wa_confirm") ?? ""),
    wa_delivery: String(fd.get("wa_delivery") ?? ""),
    wa_pickup: String(fd.get("wa_pickup") ?? ""),
    wa_payment: String(fd.get("wa_payment") ?? ""),
    wa_quote: String(fd.get("wa_quote") ?? ""),
  };
  /*
   * Modelos de contrato so vêm no FormData quando a aba exibiu os campos
   * (contratos e item pago — essencial/profissional ficam sem eles na tela).
   * Ausencia = NÃO TOCAR no valor gravado; gravar "" apagaria o modelo da
   * empresa sem que ninguem tenha editado. Preservar dados e estado
   * preexistentes e regra da correcao.
   */
  if (fd.has("contract_template")) values.contract_template = contract_template;
  if (fd.has("contract_template_digital")) values.contract_template_digital = contract_template_digital;
  await setSettings(values);
  await logAction(user, "editar", "configuracao", null, `${user.name} atualizou os modelos de contrato e WhatsApp`);
  revalidatePath("/configuracoes");
}

/**
 * Tamanho do recibo (Configurações → Recibos).
 *
 * Persiste na tabela settings (KV), como os demais ajustes — sem tabela nova.
 * A validação das dimensões personalizadas roda AQUI, no servidor, de novo:
 * a barreira nunca é o componente de tela. Alterar a configuração afeta
 * apenas novas impressões; recibos já emitidos permanecem como estão.
 */
export async function saveReciboSettings(fd: FormData) {
  const user = await assertAdmin();
  const tamanho = String(fd.get("recibo_tamanho") ?? "a4");
  const validos = ["a4", "meio_a4", "quarto_a4", "personalizado"];
  if (!validos.includes(tamanho)) {
    redirect(`/configuracoes?aba=recibos&erro=${encodeURIComponent("Tamanho de recibo inválido.")}`);
  }
  const values: Record<string, string> = { recibo_tamanho: tamanho };
  if (tamanho === "personalizado") {
    const r = validarDimensoesRecibo(
      String(fd.get("recibo_largura_mm") ?? ""),
      String(fd.get("recibo_altura_mm") ?? ""),
    );
    if ("erro" in r) {
      redirect(`/configuracoes?aba=recibos&erro=${encodeURIComponent(r.erro)}`);
    }
    values.recibo_largura_mm = String(r.larguraMm);
    values.recibo_altura_mm = String(r.alturaMm);
  }
  await setSettings(values);
  await logAction(user, "editar", "configuracao", null, `${user.name} configurou o tamanho dos recibos (${tamanho})`);
  revalidatePath("/configuracoes");
}

/**
 * Configuração operacional da empresa (Configurações → Operação).
 *
 * Persiste nomenclaturas e visibilidade no KV company_settings, sempre da
 * empresa da SESSÃO (assertAdmin + setSettings sem companyId alternativo).
 * A validação roda AQUI, no servidor: o componente de tela nunca é a
 * barreira. Gravar isto muda apenas exibição — reservas, orçamentos, cauções
 * e cobranças já registrados permanecem intocados.
 */
export type ResultadoOperacaoSave = { ok: true } | { ok: false; erro: string };

export async function saveOperacaoSettings(fd: FormData): Promise<ResultadoOperacaoSave> {
  const user = await assertAdmin();
  const r = validarOperacaoForm(Object.fromEntries(fd.entries()) as Record<string, string>);
  // erro de validação volta PARA A TELA (sem redirect): o administrador vê o
  // motivo e o que digitou continua na tela — nada de “salvamento fantasma”.
  if (!r.ok) return r;
  await salvarOperacaoConfig(r.values, user.company_id);
  const perfil = resolverOperacao(r.values).perfil;
  await logAction(user, "editar", "configuracao", null, `${user.name} atualizou a configuração operacional (perfil ${perfil})`);
  /*
   * NADA de revalidatePath("/", "layout") aqui: era ele que dava a
   * sensação de lentidão depois de salvar — invalidar o layout inteiro
   * forçava o cliente a refazer a navegação toda, inclusive a página pesada
   * de Configurações. Todas as telas que consomem estas configurações são
   * force-dynamic (leem o banco a cada request), então o valor novo aparece
   * sem qualquer invalidação; só a página atual é revalidada por segurança.
   */
  revalidatePath("/configuracoes");
  return { ok: true };
}

/**
 * Restaura os rótulos e a visibilidade ao padrão da plataforma, mediante
 * ação explícita e confirmada no painel. Apaga somente as chaves `op_*` da
 * empresa da sessão — nenhum registro de reserva, orçamento, caução ou
 * cobrança é alterado ou removido.
 */
export async function restaurarOperacao(): Promise<ResultadoOperacaoSave> {
  const user = await assertAdmin();
  await restaurarOperacaoConfig(user.company_id);
  await logAction(user, "editar", "configuracao", null, `${user.name} restaurou os padrões da configuração operacional`);
  revalidatePath("/configuracoes");
  return { ok: true };
}

/* ---------------------------------- usuarios ----------------------------------- */

/**
 * Criação de usuário: as regras de AUTORIZAÇÃO (quem pode, quais papéis,
 * limite do plano) vivem em lib/usuarios.ts — testáveis sem sessão. Aqui só
 * resta a ponte com a sessão e o FormData.
 */
export async function createUser(_prev: string | null, fd: FormData): Promise<string | null> {
  const user = await assertAdmin();
  const r = await criarUsuario(
    { id: user.id, name: user.name, company_id: user.company_id, role: user.role },
    {
      name: String(fd.get("name") ?? ""),
      username: String(fd.get("username") ?? ""),
      email: String(fd.get("email") ?? ""),
      phone: String(fd.get("phone") ?? ""),
      password: String(fd.get("password") ?? ""),
      role: String(fd.get("role") ?? "operador"),
      // Usuário interno: SEM tipo de pessoa/documento — PF/PJ é exigência do
      // CONTRATANTE (onboarding/checkout), não da equipe da empresa.
    },
    (acao, entidade, id, resumo) => logAction(user, acao, entidade, id, resumo),
  );
  if (!r.ok) return r.erro;

  let avatarPath: string | null = null;
  const avatarFile = fd.get("avatar_file");
  if (avatarFile instanceof File && avatarFile.size > 0) {
    try {
      avatarPath = await saveUpload(avatarFile, user.id);
    } catch (e) {
      return e instanceof UploadError ? e.message : "Não foi possível salvar a foto.";
    }
  }
  if (avatarPath && r.id) {
    await run(`UPDATE users SET avatar_url = ? WHERE id = ?`, [avatarPath, r.id]);
  }
  revalidatePath("/configuracoes");
  return null;
}

/** Edição de usuário (nome, login, contato e função) — regras em lib/usuarios. */
export async function updateUser(fd: FormData): Promise<void> {
  const admin = await assertAdmin();
  const r = await atualizarUsuario(
    { id: admin.id, name: admin.name, company_id: admin.company_id, role: admin.role },
    Number(fd.get("id")),
    {
      name: String(fd.get("name") ?? ""),
      username: String(fd.get("username") ?? ""),
      email: String(fd.get("email") ?? ""),
      phone: String(fd.get("phone") ?? ""),
      role: String(fd.get("role") ?? "operacional"),
    },
    (acao, entidade, id, resumo) => logAction(admin, acao, entidade, id, resumo),
  );
  if (!r.ok) redirect(`/configuracoes?aba=usuarios&erro=${encodeURIComponent(r.erro)}`);
  revalidatePath("/configuracoes");
}

/** Exclusão definitiva do usuário — libera a vaga do plano (regras em lib/usuarios). */
export async function deleteUser(fd: FormData): Promise<void> {
  const admin = await assertAdmin();
  const r = await excluirUsuario(
    { id: admin.id, name: admin.name, company_id: admin.company_id, role: admin.role },
    Number(fd.get("id")),
    (acao, entidade, id, resumo) => logAction(admin, acao, entidade, id, resumo),
  );
  if (!r.ok) redirect(`/configuracoes?aba=usuarios&erro=${encodeURIComponent(r.erro)}`);
  revalidatePath("/configuracoes");
}

export async function toggleUser(fd: FormData) {
  const admin = await assertAdmin();
  const r = await alternarStatusUsuario(
    { id: admin.id, name: admin.name, company_id: admin.company_id, role: admin.role },
    Number(fd.get("id")),
    (acao, entidade, id, resumo) => logAction(admin, acao, entidade, id, resumo),
  );
  if (!r.ok) redirect(`/configuracoes?aba=usuarios&erro=${encodeURIComponent(r.erro)}`);
  revalidatePath("/configuracoes");
}

export async function resetPassword(fd: FormData): Promise<void> {
  const admin = await assertAdmin();
  const id = Number(fd.get("id"));
  const password = String(fd.get("password") ?? "");
  if (password.length < 6) {
    redirect(`/configuracoes?aba=usuarios&erro=${encodeURIComponent("A senha deve ter ao menos 6 caracteres.")}`);
  }
  const u = await one<any>(`SELECT name FROM users WHERE id = ? AND company_id = ?`, [id, admin.company_id]);
  if (!u) {
    redirect(`/configuracoes?aba=usuarios&erro=${encodeURIComponent("Usuário não encontrado.")}`);
  }
  await run(`UPDATE users SET password_hash = ? WHERE id = ? AND company_id = ?`, [hashPassword(password), id, admin.company_id]);
  await logAction(admin, "editar", "usuario", id, `${admin.name} redefiniu a senha de ${u?.name}`);
  revalidatePath("/configuracoes");
}

export async function changeOwnPassword(_prev: string | null, fd: FormData): Promise<string | null> {
  const user = await requireUser();
  const current = String(fd.get("current") ?? "");
  const next = String(fd.get("next") ?? "");
  if (next.length < 6) return "A nova senha deve ter ao menos 6 caracteres.";
  const row = await one<any>(`SELECT password_hash FROM users WHERE id = ?`, [user.id]);
  if (!row || !verifyPassword(current, row.password_hash)) return "Senha atual incorreta.";
  await run(`UPDATE users SET password_hash = ? WHERE id = ?`, [hashPassword(next), user.id]);
  await logAction(user, "editar", "usuario", user.id, `${user.name} alterou a propria senha`);
  return null;
}

/**
 * Complemento cadastral do PRÓPRIO usuário — estratégia de transição para
 * contas antigas criadas antes da migração 0037 (sem tipo de pessoa, documento
 * ou e-mail). Não bloqueia o acesso: o card aparece em Minha conta enquanto
 * faltar dado, e o fluxo preenche apenas o que está VAZIO — uma vez gravado,
 * tipo e documento ficam imutáveis por aqui (mudança de identificação não é
 * permitida por FormData manipulado). Validação e unicidade são as MESMAS do
 * cadastro novo, no servidor.
 */
export async function completarCadastroAction(_prev: string | null, fd: FormData): Promise<string | null> {
  const sessao = await requireUser();
  const atual = await one<{ email: string | null; person_type: string | null; document: string | null }>(
    `SELECT email, person_type, document FROM users WHERE id = ?`,
    [sessao.id],
  );
  if (!atual) return "Usuário não encontrado.";

  const emailVazio = !atual.email;
  // PF/PJ no complemento só faz sentido para o CONTRATANTE (owner): para
  // usuário interno a classificação não é parte do modelo funcional e não
  // deve ser imposta aqui (o e-mail continua sendo complementado).
  const ehContratante = sessao.role === "owner";
  const docVazio = ehContratante && (!atual.person_type || !atual.document);
  if (!emailVazio && !docVazio)
    return "Cadastro já completo — tipo de pessoa e documento não podem ser alterados aqui.";

  let tipo: "pf" | "pj" | null = null;
  let documento: string | null = null;
  if (docVazio) {
    tipo = tipoPessoaValido(fd.get("tipo_pessoa"));
    if (!tipo) return "Selecione o tipo de pessoa: Pessoa Física (PF) ou Pessoa Jurídica (PJ).";
    const doc = documentoDoTipo(tipo, fd.get("documento"));
    if (!doc.ok) return doc.erro;
    if (await documentoJaUsado(doc.documento, sessao.id))
      return "Este CPF/CNPJ já está cadastrado em outra conta.";
    documento = doc.documento;
  }

  let emailNovo: string | null = null;
  if (emailVazio) {
    emailNovo = normalizarEmail(fd.get("email"));
    if (!emailValido(emailNovo)) return "Informe um e-mail válido — é o canal da recuperação de senha.";
    if (await emailJaUsado(emailNovo, sessao.id)) return "Este e-mail já está cadastrado em outra conta.";
  }

  // COALESCE: só preenche o que está vazio — o que já existe nunca é sobrescrito.
  await run(
    `UPDATE users SET person_type = COALESCE(person_type, ?),
                      document    = COALESCE(document, ?),
                      email       = COALESCE(NULLIF(email, ''), ?)
      WHERE id = ?`,
    [tipo, documento, emailNovo, sessao.id],
  );
  // Sem PII no log: nem CPF/CNPJ completo nem e-mail na trilha de auditoria.
  await logAction(sessao, "editar", "usuario", sessao.id, `${sessao.name} complementou o cadastro (tipo de pessoa e documento)`);
  revalidatePath("/configuracoes");
  return null;
}

/* ---------------------------------- avatar ----------------------------------- */

/**
 * Foto de perfil: cada usuario edita a PROPRIA foto; o admin pode trocar a de
 * qualquer um DA PROPIA EMPRESA pela tela de usuarios. A imagem vive na tabela
 * files existente (mesmo pipeline da logo da empresa) e no usuario fica so a
 * URL. Ao trocar, o arquivo anterior e descartado quando ninguem mais o usa —
 * sem orfaos e sem apagar imagem compartilhada (removeFileByUrl confere o uso
 * em anexos).
 */
async function aplicarAvatar(userId: number, file: File, ator: SessionUser, quandoAdmin = false): Promise<string | null> {
  if (quandoAdmin && !ehAdmin(ator.role)) return "Somente o administrador pode alterar a foto de outro usuário.";
  if (userId !== ator.id && !ehAdmin(ator.role)) return "Você só pode alterar a sua própria foto.";
  // Isolamento: o alvo tem que pertencer à MESMA empresa do ator — editar o
  // avatar de um usuário de outra empresa é indistinguível de inexistente.
  if (userId !== ator.id) {
    const alvo = await scalar<number>(`SELECT COUNT(*) FROM users WHERE id = ? AND company_id = ?`, [userId, ator.company_id]);
    if (!alvo) return "Usuário não encontrado.";
  }
  let nova: string | null = null;
  try {
    nova = await saveUpload(file, ator.id);
  } catch (e) {
    return e instanceof UploadError ? e.message : "Não foi possível salvar a foto.";
  }
  if (!nova) return null;
  const anterior = await scalar<string | null>(`SELECT avatar_url FROM users WHERE id = ?`, [userId]);
  await run(`UPDATE users SET avatar_url = ? WHERE id = ?`, [nova, userId]);
  if (anterior && anterior !== nova) await removeFileByUrl(anterior);
  await logAction(ator, "editar", "usuario", userId, `${ator.name} atualizou a foto de perfil`);
  revalidatePath("/", "layout");
  return null;
}

/** O usuario troca a propria foto (useActionState, mesma forma do PasswordForm). */
export async function saveMyAvatar(_prev: string | null, fd: FormData): Promise<string | null> {
  const user = await requireUser();
  const file = fd.get("avatar_file");
  if (!(file instanceof File) || file.size === 0) return "Escolha uma imagem primeiro.";
  return await aplicarAvatar(user.id, file, user);
}

/** Remove a propria foto (quando existe). */
export async function removeMyAvatar(): Promise<void> {
  const user = await requireUser();
  const anterior = await scalar<string | null>(`SELECT avatar_url FROM users WHERE id = ?`, [user.id]);
  if (!anterior) return;
  await run(`UPDATE users SET avatar_url = NULL WHERE id = ?`, [user.id]);
  await removeFileByUrl(anterior);
  await logAction(user, "editar", "usuario", user.id, `${user.name} removeu a foto de perfil`);
  revalidatePath("/", "layout");
}

/** Admin troca a foto de qualquer usuario (form action, como toggleUser). */
export async function saveUserAvatarAdmin(fd: FormData): Promise<void> {
  const admin = await assertAdmin();
  const id = Number(fd.get("id"));
  const file = fd.get("avatar_file");
  if (!Number.isInteger(id) || !(file instanceof File) || file.size === 0) {
    redirect(`/configuracoes?aba=usuarios&erro=${encodeURIComponent("Escolha uma imagem para a foto.")}`);
  }
  const erro = await aplicarAvatar(id, file as File, admin, true);
  if (erro) redirect(`/configuracoes?aba=usuarios&erro=${encodeURIComponent(erro)}`);
}

/** Admin remove a foto de qualquer usuario DA PROPIA empresa. */
export async function removeUserAvatarAdmin(fd: FormData): Promise<void> {
  const admin = await assertAdmin();
  const id = Number(fd.get("id"));
  // A linha só existe se o usuário pertence à empresa do admin.
  const pertence = await scalar<number>(`SELECT COUNT(*) FROM users WHERE id = ? AND company_id = ?`, [id, admin.company_id]);
  if (!pertence) return;
  const anterior = await scalar<string | null>(`SELECT avatar_url FROM users WHERE id = ?`, [id]);
  if (!anterior) return;
  await run(`UPDATE users SET avatar_url = NULL WHERE id = ?`, [id]);
  await removeFileByUrl(anterior);
  await logAction(admin, "editar", "usuario", id, `${admin.name} removeu a foto de perfil`);
  revalidatePath("/", "layout");
}

/* ------------------------------ assinatura da empresa ------------------------------ */

/**
 * Assinatura digital da empresa: grava o PNG desenhado no canvas da aba
 * Assinatura. Somente o administrador (proprietario) chega aqui — a action
 * confere o papel de novo, porque a tela nunca e a barreira de seguranca.
 *
 * Erro volta como string e e exibido sem limpar o desenho: nada e gravado
 * pela metade (ou grava arquivo e chave juntos, ou nao grava nada).
 */
export async function saveCompanySignature(_prev: string | null, fd: FormData): Promise<string | null> {
  const user = await assertAdmin();
  const imagem = String(fd.get("signature_image") ?? "");
  const resultado = await salvarAssinaturaEmpresa(imagem, user);
  if (!resultado.ok) return resultado.erro;
  revalidatePath("/configuracoes");
  return null;
}

/** Remove a assinatura cadastrada. Documentos ja gerados nao sao tocados. */
export async function removeCompanySignature(): Promise<void> {
  const user = await assertAdmin();
  await removerAssinaturaEmpresa(user);
  revalidatePath("/configuracoes");
}

/* --------------------------------- categorias ----------------------------------- */

export async function addCategory(fd: FormData) {
  const { user } = await requireModuleEdit("configuracoes");
  const name = String(fd.get("name") ?? "").trim();
  if (!name) return;
  await run(`INSERT OR IGNORE INTO categories (name, company_id) VALUES (?,?)`, [name, user.company_id]);
  await logAction(user, "criar", "categoria", null, `${user.name} criou a categoria ${name}`);
  revalidatePath("/configuracoes");
}

export async function removeCategory(fd: FormData) {
  const user = await assertAdmin();
  const id = Number(fd.get("id"));
  // Categoria é POR EMPRESA (migration 0027): remover a de outro tenant é
  // indistinguível de remover uma inexistente.
  const c = await one<any>(`SELECT name FROM categories WHERE id = ? AND company_id = ?`, [id, user.company_id]);
  if (!c) return;
  const usados = await scalar<number>(`SELECT COUNT(*) FROM products WHERE category_id = ? AND company_id = ?`, [id, user.company_id]);
  if (usados > 0) {
    redirect(`/configuracoes?erro=${encodeURIComponent("Categoria em uso por produtos, não pode ser removida.")}`);
  }
  await run(`DELETE FROM categories WHERE id = ? AND company_id = ?`, [id, user.company_id]);
  await logAction(user, "excluir", "categoria", id, `${user.name} removeu a categoria ${c?.name}`);
  revalidatePath("/configuracoes");
}

/** Parametros usados pela calculadora de frete. */
export async function saveFreightSettings(fd: FormData) {
  const user = await assertAdmin();
  const tipo = fd.get("tipo");
  if (tipo !== "comum" && tipo !== "locacao") throw new Error("Tipo de frete inválido.");
  const values = {
    freight_fuel_type: String(fd.get("fuel_type") ?? "").trim() || "Combustivel",
    freight_fuel_price_cents: String(parseMoney(String(fd.get("fuel_price") ?? ""))),
    freight_consumption: String(Math.max(0, Number(String(fd.get("consumption") ?? "").replace(",", ".")) || 0)),
    freight_cost_per_km_cents: String(parseMoney(String(fd.get("cost_per_km") ?? ""))),
    freight_margin_percent: String(Math.max(0, Math.min(95, Number(fd.get("margin")) || 0))),
    freight_minimum_cents: String(parseMoney(String(fd.get("minimum") ?? ""))),
    freight_rounding_cents: String(parseMoney(String(fd.get("rounding") ?? ""))),
    freight_labor_cents: String(parseMoney(String(fd.get("labor") ?? ""))),
  };
  await setSettings({ ...Object.fromEntries(Object.entries(values).map(([key,value]) => [key.replace("freight_", `freight_${tipo}_`), value])), [`freight_${tipo}_base_address`]: String(fd.get("base_address") ?? "").trim().slice(0,400) });
  await logAction(user, "editar", "configuracao", null, `${user.name} atualizou os parametros do frete`);
  revalidatePath("/configuracoes");
  revalidatePath("/fretes/calculadora");
}

/**
 * Regras e mensagens da fidelidade.
 *
 * Fica tudo em settings, junto com o resto da configuracao do sistema: nao ha
 * motivo para uma tabela de programa so para guardar meia duzia de numeros que
 * o administrador edita nesta tela.
 */
export async function saveFidelitySettings(fd: FormData) {
  const user = await assertAdmin();
  const inteiro = (campo: string, padrao: number, max: number) => {
    const v = Math.trunc(Number(fd.get(campo)));
    return String(Number.isFinite(v) && v >= 0 ? Math.min(v, max) : padrao);
  };
  const marcado = (campo: string) => (String(fd.get(campo) ?? "") === "1" ? "1" : "0");

  const eventos = ["progresso", "quase_la", "conquista", "uso", "vencendo", "expirada"];
  const mensagens = Object.fromEntries(
    eventos.map((e) => [`fidelity_msg_${e}`, String(fd.get(`msg_${e}`) ?? "").trim().slice(0, 1000)]),
  );

  await setSettings({
    fidelity_active: marcado("active"),
    fidelity_goal: inteiro("goal", 5, 100) === "0" ? "1" : inteiro("goal", 5, 100),
    fidelity_kits: inteiro("kits", 5, 100),
    /* vazio volta ao padrao do perfil operacional — nunca grava lixo */
    fidelity_unidade: normalizarUnidade(String(fd.get("unidade") ?? "")),
    fidelity_validity_days: inteiro("validity_days", 0, 3650),
    fidelity_accumulate: marcado("accumulate"),
    fidelity_count_free_rental: marcado("count_free_rental"),
    fidelity_return_on_cancel: marcado("return_on_cancel"),
    fidelity_min_value_cents: String(parseMoney(String(fd.get("min_value") ?? ""))),
    fidelity_eligible_status: String(fd.get("eligible_status") ?? "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean)
      .join(","),
    fidelity_expiry_reminders: String(fd.get("expiry_reminders") ?? "").trim().slice(0, 60),
    fidelity_window_start: String(fd.get("window_start") ?? "08:00").slice(0, 5),
    fidelity_window_end: String(fd.get("window_end") ?? "20:00").slice(0, 5),
    fidelity_notify_progress: marcado("fidelity_notify_progress"),
    fidelity_notify_almost: marcado("fidelity_notify_almost"),
    fidelity_notify_earned: marcado("fidelity_notify_earned"),
    fidelity_notify_used: marcado("fidelity_notify_used"),
    fidelity_notify_expiring: marcado("fidelity_notify_expiring"),
    fidelity_notify_expired: marcado("fidelity_notify_expired"),
    ...mensagens,
  });

  // alterar a regra nao mexe em recompensa ja conquistada: cada uma guarda o
  // retrato da regra do dia em que nasceu
  await logAction(user, "editar", "configuracao", null, `${user.name} atualizou o programa de fidelidade`);
  revalidatePath("/configuracoes");
  revalidatePath("/fidelidade");
}

/** Avisos de aniversario: antecedencia, canais e horario. */
export async function saveBirthdaySettings(fd: FormData) {
  const user = await assertAdmin();
  const inteiro = (campo: string, padrao: number, max: number) => {
    const v = Math.trunc(Number(fd.get(campo)));
    return String(Number.isFinite(v) && v >= 0 ? Math.min(v, max) : padrao);
  };
  const marcado = (campo: string) => (String(fd.get(campo) ?? "") === "1" ? "1" : "0");

  await setSettings({
    birthday_active: marcado("active"),
    birthday_days_ahead: inteiro("days_ahead", 7, 366),
    birthday_notify_today: marcado("notify_today"),
    birthday_notify_upcoming: marcado("notify_upcoming"),
    birthday_push: marcado("push"),
    birthday_hour: inteiro("hour", 8, 23),
  });
  await logAction(user, "editar", "configuracao", null, `${user.name} atualizou os avisos de aniversario`);
  revalidatePath("/configuracoes");
  revalidatePath("/aniversarios");
}

/* ------------------------------------------------------------------ */
/* E-mails transacionais (Configurações > Notificações > E-mails)       */
/* ------------------------------------------------------------------ */

export type ResultadoEmailSave = { ok: true } | { ok: false; erro: string };

/** Interruptores que o formulário envia SEMPRE (oculto "0"/"1" ao lado de cada checkbox). */
const INTERRUPTORES_EMAIL = [
  "email_enabled",
  "email_grupo_reservas",
  "email_grupo_operacoes",
  "email_grupo_fidelidade",
  "email_reserva_confirmacao",
  "email_reserva_lembrete",
  "email_reserva_alteracao",
  "email_reserva_cancelamento",
  "email_operacao_lembrete",
  "email_operacao_saida",
  "email_operacao_concluida",
  "email_operacao_alteracao",
  "email_operacao_atrasada",
  "email_fidelidade_progresso",
  "email_fidelidade_quase_la",
  "email_fidelidade_conquista",
  "email_fidelidade_uso",
  "email_fidelidade_vencendo",
] as const;

/**
 * Salva a configuração de e-mails da EMPRESA DA SESSÃO (assertAdmin +
 * setSettings escopado). Toda validação roda AQUI: a tela nunca é a barreira.
 * Campos ausentes do FormData não são tocados (abas/opções que a tela não
 * exibiu preservam o que já estava gravado).
 */
export async function saveEmailSettings(
  _prev: ResultadoEmailSave | null,
  fd: FormData,
): Promise<ResultadoEmailSave> {
  const user = await assertAdmin();
  const values: Record<string, string> = {};

  for (const campo of INTERRUPTORES_EMAIL) {
    if (fd.has(campo)) values[campo] = String(fd.get(campo)) === "1" ? "1" : "0";
  }

  /** Lista de antecedências enviada como itens repetidos (minutos). */
  const antecedencias = (campo: string): string | { ok: false; erro: string } => {
    const bruto = fd.getAll(campo).map((v) => String(v ?? "").trim()).filter(Boolean);
    if (!bruto.length) return ""; // em branco = voltar ao padrão documentado
    if (bruto.some((v) => !/^\d+$/.test(v))) return { ok: false, erro: "Antecedência inválida: use apenas números (minutos)." };
    const csv = bruto.join(",");
    if (!antecedenciasValidas(csv)) {
      return {
        ok: false,
        erro: `Antecedência inválida: de 1 a ${MAX_ANTECEDENCIAS} lembretes, entre 5 minutos e 14 dias cada.`,
      };
    }
    return csv;
  };

  /* Os hidden inputs da tela se chamam `antec_reserva` / `antec_operacao` (itens
     repetidos, um por lembrete). Antes o guard lia `fd.has("email_...")`, que
     nunca existia no FormData: as antecedências digitadas NÃO eram gravadas e
     a tela voltava aos padrões na próxima atualização — perda silenciosa. */
  if (fd.has("antec_reserva")) {
    const r = antecedencias("antec_reserva");
    if (typeof r === "object") return r;
    values.email_reserva_lembrete_antecedencias = r;
  }
  if (fd.has("antec_operacao")) {
    const r = antecedencias("antec_operacao");
    if (typeof r === "object") return r;
    values.email_operacao_lembrete_antecedencias = r;
  }

  if (fd.has("email_hora_envio")) {
    const hora = String(fd.get("email_hora_envio") ?? "").trim();
    if (!horaValida(hora)) return { ok: false, erro: "Hora de envio inválida — use o formato HH:MM (ex.: 08:00)." };
    values.email_hora_envio = hora;
  }
  if (fd.has("email_fuso")) {
    const fuso = String(fd.get("email_fuso") ?? "").trim();
    if (fuso && !fusoValido(fuso)) return { ok: false, erro: "Fuso horário inválido — use um identificador IANA (ex.: America/Sao_Paulo)." };
    values.email_fuso = fuso;
  }
  if (fd.has("email_cor")) {
    const cor = String(fd.get("email_cor") ?? "").trim();
    if (cor && !corValida(cor)) return { ok: false, erro: "Cor inválida — use o formato #RRGGBB (ex.: #C94F00)." };
    values.email_cor = cor;
  }
  if (fd.has("email_fidelidade_quase_la_limite")) {
    const n = Math.trunc(Number(fd.get("email_fidelidade_quase_la_limite")));
    if (!Number.isFinite(n) || n < 1 || n > 999) {
      return { ok: false, erro: "Limite de proximidade deve ser um número entre 1 e 999." };
    }
    values.email_fidelidade_quase_la_limite = String(n);
  }
  if (fd.has("email_instrucoes")) {
    values.email_instrucoes = String(fd.get("email_instrucoes") ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 500);
  }

  await setSettings(values);
  await logAction(user, "editar", "configuracao", null, `${user.name} atualizou a configuração de e-mails`);
  revalidatePath("/configuracoes");
  return { ok: true };
}

/**
 * E-mail de teste: monta a amostra com dados FICTÍCIOS e envia na hora para o
 * endereço informado. Não consulta nenhum cliente, não cria reserva e não passa
 * pela fila — é a única leitura síncrona do provedor, feita de propósito para
 * o administrador ver o resultado imediatamente.
 */
export async function sendTestEmail(fd: FormData): Promise<void> {
  const user = await assertAdmin();
  const destino = normalizarEmail(fd.get("destino"));
  if (!emailValido(destino)) {
    redirect(`/configuracoes?aba=notificacoes&erro=${encodeURIComponent("Informe um e-mail válido para receber o teste.")}`);
  }

  const ident = await identidadeDaEmpresa(user.company_id);
  const m = emailTeste(ident, destino);
  const r = await enviarEmailDetalhado({ to: destino, subject: m.assunto, html: m.html, text: m.texto, deNome: ident.nome });

  const agora = Math.floor(Date.now() / 1000);
  const status = r.ok
    ? "enviado"
    : r.motivoConfig
      ? "ignorado"
      : r.temporaria
        ? "falha_temporaria"
        : "falha_definitiva";
  const motivo = r.motivoConfig ? "provedor_sem_configuracao" : null;
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
      m.assunto,
      status,
      motivo,
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
  // Sem endereço no log de auditoria: o histórico já guarda o destinatário.
  await logAction(user, "editar", "configuracao", null, `${user.name} enviou um e-mail de teste (${status})`);

  if (r.ok) {
    redirect(`/configuracoes?aba=notificacoes&ok=${encodeURIComponent("E-mail de teste enviado para o endereço informado.")}`);
  }
  const motivoTexto = r.motivoConfig
    ? "Provedor não configurado no Worker (RESEND_API_KEY / RESEND_FROM)."
    : `Falha no envio: ${String(r.erro ?? "erro desconhecido").slice(0, 200)}`;
  redirect(`/configuracoes?aba=notificacoes&erro=${encodeURIComponent(motivoTexto)}`);
}
