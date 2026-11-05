/**
 * Biblioteca de variáveis dos modelos de e-mail — camada PURA.
 *
 * Regras (as mesmas que o envio real obedece):
 *
 *  * Só existe variável que o contexto consegue preencher. Cada definição diz
 *    em quais contextos ela vale (`reserva`, `operacao`, `fidelidade`), e a tela
 *    só oferece essas. `{{orcamento_*}}` não está aqui de propósito: o sistema
 *    não envia e-mail de orçamento (não há gatilho implementado), então a
 *    variável nunca teria valor — oferecê-la seria prometer o que não existe.
 *
 *  * Valor é DADO, nunca marcação: todo valor textual entra escapado, então o
 *    cadastro do cliente não injeta HTML. A única exceção é a lista de itens,
 *    montada pelo próprio sistema e marcada como confiável.
 *
 *  * Variável sem valor DESAPARECE. Nada de `undefined`, `null`, "0" inventado
 *    ou sobra de chaves. Espaços duplicados resultantes são normalizados.
 *
 *  * Acentuação é preservada: o escape apenas converte os cinco caracteres que
 *    têm significado em HTML.
 */

/* ------------------------------------------------------------------ */
/* Tipos                                                               */
/* ------------------------------------------------------------------ */

export type ContextoVariaveis = "reserva" | "operacao" | "fidelidade";

export type GrupoVariavel = "cliente" | "empresa" | "reserva" | "operacao" | "fidelidade" | "sistema";

/**
 * Valor de uma variável. `string` é dado comum (escapado na hora de renderizar).
 * `{ html }` é conteúdo montado pelo SISTEMA (a lista de itens), que pode
 * carregar marcação própria; `texto` é a mesma informação sem marcação, para a
 * alternativa em texto puro do e-mail.
 */
export type ValorVariavel = string | { html: string; texto: string };

export type VariaveisEmail = Record<string, ValorVariavel>;

export type PersonalizacaoEmail = {
  modelo: import("./email-modelos").ModeloEmail;
  vars: VariaveisEmail;
};

export type DefinicaoVariavel = {
  chave: string;
  rotulo: string;
  descricao: string;
  exemplo: string;
  grupo: GrupoVariavel;
  contextos: ContextoVariaveis[];
};

/* ------------------------------------------------------------------ */
/* Escape local (não importa contract-html: este módulo roda no cliente) */
/* ------------------------------------------------------------------ */

const ENTIDADES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Escapa os cinco caracteres com significado em HTML. Idempotente na prática. */
export function escaparHtml(texto: string): string {
  return String(texto ?? "").replace(/[&<>"']/g, (c) => ENTIDADES[c]);
}

/** Volta as entidades básicas para a alternativa em texto puro. */
function desescapar(texto: string): string {
  return String(texto ?? "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/* ------------------------------------------------------------------ */
/* Catálogo                                                            */
/* ------------------------------------------------------------------ */

export const GRUPOS_VARIAVEIS: Record<GrupoVariavel, { rotulo: string; descricao: string }> = {
  cliente: { rotulo: "Dados do cliente", descricao: "Quem recebe o e-mail, conforme o cadastro do cliente." },
  empresa: { rotulo: "Dados da empresa", descricao: "Identidade e contatos desta locadora (Configurações > Empresa)." },
  reserva: { rotulo: "Dados da reserva", descricao: "Informações da reserva que originou o aviso." },
  operacao: { rotulo: "Dados da operação", descricao: "Entrega, retirada ou devolução vinculada à reserva." },
  fidelidade: { rotulo: "Programa de fidelidade", descricao: "Saldo, meta e recompensa do cliente." },
  sistema: { rotulo: "Outras informações", descricao: "Data do envio e link de acesso do cliente." },
};

export const VARIAVEIS_EMAIL: DefinicaoVariavel[] = [
  /* ------------------------------ cliente ------------------------------ */
  {
    chave: "cliente_nome",
    rotulo: "Primeiro nome do cliente",
    descricao: "Tratamento natural na saudação (ex.: “Olá, Ana”).",
    exemplo: "Ana",
    grupo: "cliente",
    contextos: ["reserva", "operacao"],
  },
  {
    chave: "cliente_nome_completo",
    rotulo: "Nome completo do cliente",
    descricao: "Nome como está no cadastro do cliente.",
    exemplo: "Ana Souza",
    grupo: "cliente",
    contextos: ["reserva", "operacao"],
  },
  {
    chave: "cliente_email",
    rotulo: "E-mail do cliente",
    descricao: "Endereço cadastrado — o mesmo que recebe o aviso.",
    exemplo: "ana@exemplo.com",
    grupo: "cliente",
    contextos: ["reserva", "operacao"],
  },
  {
    chave: "cliente_telefone",
    rotulo: "Telefone do cliente",
    descricao: "Telefone cadastrado no cliente.",
    exemplo: "(11) 99999-0000",
    grupo: "cliente",
    contextos: ["reserva", "operacao"],
  },

  /* ------------------------------ empresa ------------------------------ */
  {
    chave: "empresa_nome",
    rotulo: "Nome da empresa",
    descricao: "Nome comercial desta locadora.",
    exemplo: "Festas Lima",
    grupo: "empresa",
    contextos: ["reserva", "operacao", "fidelidade"],
  },
  {
    chave: "empresa_telefone",
    rotulo: "Telefone da empresa",
    descricao: "Telefone de contato cadastrado.",
    exemplo: "(11) 3333-4444",
    grupo: "empresa",
    contextos: ["reserva", "operacao", "fidelidade"],
  },
  {
    chave: "empresa_whatsapp",
    rotulo: "WhatsApp da empresa",
    descricao: "Número de WhatsApp cadastrado.",
    exemplo: "(11) 99999-0000",
    grupo: "empresa",
    contextos: ["reserva", "operacao", "fidelidade"],
  },
  {
    chave: "empresa_email",
    rotulo: "E-mail da empresa",
    descricao: "Endereço de contato da locadora.",
    exemplo: "contato@festaslima.com.br",
    grupo: "empresa",
    contextos: ["reserva", "operacao", "fidelidade"],
  },
  {
    chave: "empresa_endereco",
    rotulo: "Endereço da empresa",
    descricao: "Endereço cadastrado da empresa.",
    exemplo: "Rua das Flores, 120",
    grupo: "empresa",
    contextos: ["reserva", "operacao", "fidelidade"],
  },
  {
    chave: "empresa_cidade",
    rotulo: "Cidade da empresa",
    descricao: "Cidade cadastrada da empresa.",
    exemplo: "São Paulo",
    grupo: "empresa",
    contextos: ["reserva", "operacao", "fidelidade"],
  },
  {
    chave: "empresa_documento",
    rotulo: "CNPJ ou CPF da empresa",
    descricao: "Documento cadastrado em Configurações > Empresa.",
    exemplo: "12.345.678/0001-90",
    grupo: "empresa",
    contextos: ["reserva", "operacao", "fidelidade"],
  },

  /* ------------------------------ reserva ------------------------------ */
  {
    chave: "reserva_codigo",
    rotulo: "Número da reserva",
    descricao: "Código da reserva (ex.: RES-0012).",
    exemplo: "RES-0012",
    grupo: "reserva",
    contextos: ["reserva", "operacao"],
  },
  {
    chave: "reserva_data_evento",
    rotulo: "Data do evento",
    descricao: "Data do evento da reserva, no formato dd/mm/aaaa.",
    exemplo: "12/10/2026",
    grupo: "reserva",
    contextos: ["reserva"],
  },
  {
    chave: "reserva_horario",
    rotulo: "Horário do evento",
    descricao: "Horário do evento, quando cadastrado.",
    exemplo: "19:00",
    grupo: "reserva",
    contextos: ["reserva"],
  },
  {
    chave: "reserva_data_retirada",
    rotulo: "Início da locação",
    descricao: "Data e hora do início (entrega ou retirada, conforme o perfil da empresa).",
    exemplo: "12/10/2026 08:00",
    grupo: "reserva",
    contextos: ["reserva"],
  },
  {
    chave: "reserva_data_devolucao",
    rotulo: "Fim da locação",
    descricao: "Data e hora do fim (retirada ou devolução, conforme o perfil da empresa).",
    exemplo: "12/10/2026 18:00",
    grupo: "reserva",
    contextos: ["reserva"],
  },
  {
    chave: "reserva_endereco_entrega",
    rotulo: "Endereço do evento",
    descricao: "Endereço e cidade cadastrados na reserva.",
    exemplo: "Rua das Flores, 120, São Paulo",
    grupo: "reserva",
    contextos: ["reserva"],
  },
  {
    chave: "reserva_status",
    rotulo: "Status da reserva",
    descricao: "Situação atual da reserva (Confirmada, Em uso, Cancelada…).",
    exemplo: "Confirmada",
    grupo: "reserva",
    contextos: ["reserva"],
  },
  {
    chave: "reserva_valor_total",
    rotulo: "Valor total da reserva",
    descricao: "Total contratado da reserva.",
    exemplo: "R$ 1.250,00",
    grupo: "reserva",
    contextos: ["reserva"],
  },
  {
    chave: "reserva_valor_adiantamento",
    rotulo: "Adiantamento combinado",
    descricao: "Adiantamento previsto para esta reserva (não é o valor já pago).",
    exemplo: "R$ 375,00",
    grupo: "reserva",
    contextos: ["reserva"],
  },
  {
    chave: "reserva_valor_pendente",
    rotulo: "Saldo pendente",
    descricao: "Total da reserva menos o que já foi efetivamente pago.",
    exemplo: "R$ 875,00",
    grupo: "reserva",
    contextos: ["reserva"],
  },
  {
    chave: "reserva_itens",
    rotulo: "Itens da reserva",
    descricao: "Lista de produtos com quantidade, uma linha por item. Sem itens, a variável desaparece.",
    exemplo: "Mesa × 10 / Cadeira × 40",
    grupo: "reserva",
    contextos: ["reserva"],
  },

  /* ------------------------------ operação ----------------------------- */
  {
    chave: "operacao_tipo",
    rotulo: "Tipo de operação",
    descricao: "Rótulo usado pela empresa: Entrega, Retirada, Devolução…",
    exemplo: "Entrega",
    grupo: "operacao",
    contextos: ["operacao"],
  },
  {
    chave: "operacao_data_hora",
    rotulo: "Data e hora da operação",
    descricao: "Momento agendado (ou registrado) da operação.",
    exemplo: "12/10/2026 08:00",
    grupo: "operacao",
    contextos: ["operacao"],
  },
  {
    chave: "operacao_endereco",
    rotulo: "Endereço da operação",
    descricao: "Endereço da reserva vinculada à operação.",
    exemplo: "Rua das Flores, 120, São Paulo",
    grupo: "operacao",
    contextos: ["operacao"],
  },
  {
    chave: "operacao_status",
    rotulo: "Status da operação",
    descricao: "Situação atual da operação.",
    exemplo: "Em rota",
    grupo: "operacao",
    contextos: ["operacao"],
  },
  {
    chave: "operacao_observacao",
    rotulo: "Observação da operação",
    descricao: "Anotação registrada pela equipe, quando existir.",
    exemplo: "Portão de serviço, tocar o interfone.",
    grupo: "operacao",
    contextos: ["operacao"],
  },

  /* ----------------------------- fidelidade ---------------------------- */
  {
    chave: "fidelidade_atual",
    rotulo: "Saldo atual",
    descricao: "Quantidade já acumulada no programa.",
    exemplo: "7",
    grupo: "fidelidade",
    contextos: ["fidelidade"],
  },
  {
    chave: "fidelidade_meta",
    rotulo: "Meta do programa",
    descricao: "Quantidade necessária para a recompensa.",
    exemplo: "10",
    grupo: "fidelidade",
    contextos: ["fidelidade"],
  },
  {
    chave: "fidelidade_faltam",
    rotulo: "Quanto falta",
    descricao: "Quantidade restante para atingir a meta.",
    exemplo: "3",
    grupo: "fidelidade",
    contextos: ["fidelidade"],
  },
  {
    chave: "fidelidade_beneficio",
    rotulo: "Recompensa",
    descricao: "Benefício conquistado ou em uso.",
    exemplo: "1 kit grátis",
    grupo: "fidelidade",
    contextos: ["fidelidade"],
  },
  {
    chave: "fidelidade_validade",
    rotulo: "Validade da recompensa",
    descricao: "Prazo para usar o benefício, quando houver.",
    exemplo: "30/11/2026",
    grupo: "fidelidade",
    contextos: ["fidelidade"],
  },
  {
    chave: "fidelidade_unidade",
    rotulo: "Unidade do programa",
    descricao: "Como a empresa chama a unidade contada (kit, locação…).",
    exemplo: "kits",
    grupo: "fidelidade",
    contextos: ["fidelidade"],
  },

  /* ------------------------------- sistema ----------------------------- */
  {
    chave: "data_atual",
    rotulo: "Data de hoje",
    descricao: "Data do envio, no fuso configurado.",
    exemplo: "05/11/2026",
    grupo: "sistema",
    contextos: ["reserva", "operacao", "fidelidade"],
  },
  {
    chave: "link_portal",
    rotulo: "Link do portal do cliente",
    descricao: "Endereço de acesso do cliente (área do cliente da locadora).",
    exemplo: "https://…/portal/login",
    grupo: "sistema",
    contextos: ["reserva", "operacao", "fidelidade"],
  },
];

/** Contexto de cada tipo de aviso — define quais variáveis a tela oferece. */
export const CONTEXTO_DO_TIPO: Record<import("./email-notificacoes").TipoEmail, ContextoVariaveis> = {
  reserva_confirmacao: "reserva",
  reserva_lembrete: "reserva",
  reserva_alteracao: "reserva",
  reserva_cancelamento: "reserva",
  operacao_lembrete: "operacao",
  operacao_saida: "operacao",
  operacao_concluida: "operacao",
  operacao_alteracao: "operacao",
  operacao_atrasada: "operacao",
  fidelidade_progresso: "fidelidade",
  fidelidade_quase_la: "fidelidade",
  fidelidade_conquista: "fidelidade",
  fidelidade_uso: "fidelidade",
  fidelidade_vencendo: "fidelidade",
  email_teste: "reserva",
};

/** Variáveis válidas para o contexto de um tipo de aviso. */
export function variaveisDoContexto(contexto: ContextoVariaveis): DefinicaoVariavel[] {
  return VARIAVEIS_EMAIL.filter((v) => v.contextos.includes(contexto));
}

export function variaveisDoTipo(tipo: import("./email-notificacoes").TipoEmail): DefinicaoVariavel[] {
  return variaveisDoContexto(CONTEXTO_DO_TIPO[tipo] ?? "reserva");
}

/** Só as chaves — usado na validação do editor. */
export function chavesDoTipo(tipo: import("./email-notificacoes").TipoEmail): string[] {
  return variaveisDoTipo(tipo).map((v) => v.chave);
}

/* ------------------------------------------------------------------ */
/* Substituição                                                        */
/* ------------------------------------------------------------------ */

/** `{{chave}}`, com espaços internos opcionais. */
const TOKEN = /\{\{\s*([a-z0-9_]+)\s*\}\}/gi;

export function chavesUsadas(texto: string | null | undefined): string[] {
  const vistas = new Set<string>();
  for (const m of String(texto ?? "").matchAll(TOKEN)) vistas.add(m[1].toLowerCase());
  return [...vistas];
}

/** Chaves escritas no texto que NÃO existem no contexto (para avisar na tela). */
export function chavesInvalidas(texto: string | null | undefined, permitidas: readonly string[]): string[] {
  const ok = new Set(permitidas.map((c) => c.toLowerCase()));
  return chavesUsadas(texto).filter((c) => !ok.has(c));
}

/** `-` é o "sem dado" dos formatadores: em e-mail isso vira ausência. */
function limpar(valor: string | null | undefined): string {
  const t = String(valor ?? "").trim();
  return t === "-" ? "" : t;
}

function stringDe(valor: ValorVariavel | undefined, escapar: boolean): string | null {
  if (valor === undefined || valor === null) return null;
  if (typeof valor === "string") {
    const t = limpar(valor);
    return t ? (escapar ? escaparHtml(t) : t) : null;
  }
  return escapar ? valor.html : valor.texto;
}

/**
 * Substitui as variáveis do texto. Sem valor (ou chave desconhecida) a variável
 * desaparece — nunca `undefined`/`null`. `escapar: false` só é usado em assunto,
 * que não é HTML.
 */
export function aplicarVariaveis(
  texto: string | null | undefined,
  vars: VariaveisEmail,
  opts: { escapar?: boolean } = {},
): string {
  const escapar = opts.escapar !== false;
  return String(texto ?? "").replace(TOKEN, (_m, chave: string) => stringDe(vars[chave.toLowerCase()], escapar) ?? "");
}

/** Versão em texto puro (alternativa sem HTML do e-mail). */
export function aplicarVariaveisTexto(texto: string | null | undefined, vars: VariaveisEmail): string {
  return aplicarVariaveis(texto, vars, { escapar: false });
}

/**
 * Texto digitado pela empresa → parágrafos de e-mail.
 *
 * O conteúdo é TEXTO (não HTML): cada bloco separado por linha em branco vira um
 * parágrafo e cada quebra simples vira `<br/>`. Assim a empresa não precisa
 * escrever marcação — e nada que ela digite vira tag executável.
 */
export function paragrafosDeHtml(texto: string | null | undefined, vars: VariaveisEmail): string[] {
  const bruto = aplicarVariaveis(texto, vars, { escapar: true });
  return bruto
    .split(/\n{2,}/)
    .map((p) => p.replace(/[ \t]{2,}/g, " ").trim())
    .filter(Boolean)
    .map((p) => `<p style="margin:0 0 12px;">${p.replace(/\r?\n/g, "<br/>")}</p>`);
}

/** Lista de itens pronta para o corpo (HTML confiável + texto puro). */
export function variavelItens(itens: { nome: string; qtd: number }[] | null | undefined): { html: string; texto: string } {
  const lista = (itens ?? []).filter((i) => String(i?.nome ?? "").trim());
  if (!lista.length) return { html: "", texto: "" };
  const html = lista
    .map((i) => {
      const qtd = Number(i.qtd) || 0;
      return `${escaparHtml(i.nome)} <span style="color:#6B7280;">× ${qtd}</span>`;
    })
    .join("<br/>");
  const texto = lista.map((i) => `- ${i.nome} (×${Number(i.qtd) || 0})`).join("\n");
  return { html, texto };
}

/* ------------------------------------------------------------------ */
/* Construtores por contexto                                           */
/* ------------------------------------------------------------------ */

type Identidade = import("./email-templates").IdentidadeEmail;
type Reserva = import("./email-templates").ReservaEmail;
type Operacao = import("./email-templates").OperacaoEmail;
type Fidelidade = import("./email-templates").FidelidadeEmail;

function variaveisEmpresa(ident: Identidade): VariaveisEmail {
  const portal = ident.baseUrl ? `${String(ident.baseUrl).trim().replace(/\/+$/, "")}/portal/login` : "";
  return {
    empresa_nome: ident.nome,
    empresa_telefone: ident.telefone,
    empresa_whatsapp: ident.whatsapp,
    empresa_email: ident.email,
    empresa_endereco: ident.endereco,
    empresa_cidade: ident.cidade,
    empresa_documento: ident.documento ?? "",
    link_portal: portal,
    data_atual: dataAtualBR(),
  };
}

/** Data de hoje no fuso do negócio (dd/mm/aaaa), sem depender do relógio do servidor. */
function dataAtualBR(): string {
  const partes = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const [ano, mes, dia] = partes.split("-");
  return `${dia}/${mes}/${ano}`;
}

export function variaveisDeReserva(ident: Identidade, r: Reserva): VariaveisEmail {
  return {
    ...variaveisEmpresa(ident),
    cliente_nome: desescapar(r.cliente),
    cliente_nome_completo: desescapar(r.clienteCompleto ?? r.cliente),
    cliente_email: r.clienteEmail ?? "",
    cliente_telefone: r.clienteTelefone ?? "",
    reserva_codigo: r.numero,
    reserva_data_evento: r.dataEvento,
    reserva_horario: r.horaEvento,
    reserva_data_retirada: r.inicio,
    reserva_data_devolucao: r.fim,
    reserva_endereco_entrega: r.endereco,
    reserva_status: r.status,
    reserva_valor_total: r.valorTotal ?? "",
    reserva_valor_adiantamento: r.valorAdiantamento ?? "",
    reserva_valor_pendente: r.valorPendente ?? "",
    reserva_itens: variavelItens(r.itens),
  };
}

export function variaveisDeOperacao(ident: Identidade, o: Operacao): VariaveisEmail {
  return {
    ...variaveisEmpresa(ident),
    cliente_nome: desescapar(o.cliente),
    cliente_nome_completo: desescapar(o.clienteCompleto ?? o.cliente),
    cliente_email: o.clienteEmail ?? "",
    cliente_telefone: o.clienteTelefone ?? "",
    reserva_codigo: o.numero,
    operacao_tipo: o.tipo,
    operacao_data_hora: o.quando,
    operacao_endereco: o.endereco,
    operacao_status: o.status,
    operacao_observacao: o.obs,
  };
}

export function variaveisDeFidelidade(ident: Identidade, f: Fidelidade): VariaveisEmail {
  return {
    ...variaveisEmpresa(ident),
    cliente_nome: desescapar(f.cliente),
    cliente_nome_completo: desescapar(f.clienteCompleto ?? f.cliente),
    fidelidade_atual: String(f.atual),
    fidelidade_meta: String(f.meta),
    fidelidade_faltam: String(Math.max(0, f.faltam)),
    fidelidade_beneficio: f.beneficio,
    fidelidade_validade: f.quando,
    fidelidade_unidade: f.unidade,
  };
}

/** Personalização pronta para o template, ou undefined quando não há modelo. */
export function personalizacao(
  modelo: import("./email-modelos").ModeloEmail | null | undefined,
  vars: VariaveisEmail,
): PersonalizacaoEmail | undefined {
  return modelo && Object.keys(modelo).length ? { modelo, vars } : undefined;
}

/** Remove as tags de um trecho já renderizado, para a alternativa em texto puro. */
export function soTexto(html: string): string {
  return desescapar(String(html ?? "").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, ""));
}
