/**
 * Configurações operacionais por empresa — nomenclaturas, visibilidade e perfil.
 *
 * Camada PURA, sem "server-only": as constantes e o resolver são compartilhados
 * com os formulários de cliente (ReservationForm/QuoteForm), com o menu e com
 * os testes. A leitura/escrita no banco vive em operacao-db.ts e o painel em
 * app/(app)/configuracoes.
 *
 * Princípios (arquitetura de configs por empresa):
 *  - Dados internos são estáveis: event_date, event_time, delivery_at,
 *    pickup_at, address, assembly_cents, disassembly_cents, deposits e os
 *    kinds de operação ("entrega"/"retirada") não mudam de nome nem de
 *    significado. Renomear um rótulo NÃO move datas, inverte operações nem
 *    altera cálculos — só muda o que a interface apresenta.
 *  - Ocultar um campo é decisão de EXIBIÇÃO: some dos formulários novos, mas
 *    o dado gravado é preservado (hidden input na edição) e a estrutura do
 *    banco permanece intacta.
 *  - Valores vazios/ausentes caem nos padrões da plataforma, que são
 *    exatamente o comportamento atual dos clientes de festas — nenhuma
 *    empresa existente muda de tela sem que o administrador salve algo.
 *  - O PERFIL é um dado gravado (op_perfil), não derivado: "Personalizado" é
 *    um perfil de primeira classe e nunca é sobrescrito por classificação.
 */

/* ------------------------------- perfis ------------------------------- */

export type PerfilOperacional = "festas" | "carretinhas" | "personalizado";

export const PERFIL_ROTULO: Record<PerfilOperacional, string> = {
  festas: "Festas e eventos",
  carretinhas: "Carretinhas e reboques",
  personalizado: "Personalizado",
};

/* ----------------------------- rótulos ------------------------------- */

/** Texto atual do sistema — o padrão que clientes atuais já veem. */
export const ROTULOS_PADRAO = {
  evento: "Data do evento",
  evento_hora: "Horário do evento",
  inicio: "Entrega em",
  fim: "Retirada em",
  /** Nome curto da operação de INÍCIO (checkbox "Entrega", menu, cartões). */
  operacao_inicio: "Entrega",
  /** Nome curto da operação de FIM (checkbox "Retirada", menu, cartões). */
  operacao_fim: "Retirada",
} as const;

export type RotuloChave = keyof typeof ROTULOS_PADRAO;
export type Rotulos = Record<RotuloChave, string>;

/* --------------------------- visibilidade ---------------------------- */

export const VIS_PADRAO = { evento: true, endereco: true, montagem: true, caucao: true } as const;
export type VisChave = keyof typeof VIS_PADRAO;
export type Visibilidade = Record<VisChave, boolean>;

/* --------------------------- config resolvida ------------------------ */

export type OperacaoConfig = {
  /**
   * Perfil efetivamente salvo da empresa. Sem `op_perfil` no banco (empresas
   * anteriores a esta chave), deriva dos valores — nunca o contrário.
   */
  perfil: PerfilOperacional;
  rotulos: Rotulos;
  vis: Visibilidade;
  /** Quais opções divergem do padrão da plataforma (sinaliza "personalizado"). */
  personalizado: Record<RotuloChave | VisChave, boolean>;
};

/**
 * Chaves em company_settings (KV da migration 0027). Todas com prefixo `op_`:
 * a restauração de padrões apaga somente essas chaves.
 * Rótulo vazio/ausente = padrão da plataforma; visibilidade "0" = oculto,
 * qualquer outro valor (inclusive ausente) = visível.
 */
export const OPERACAO_KEYS = {
  perfil: "op_perfil",
  rotulo_evento: "op_rotulo_evento",
  rotulo_evento_hora: "op_rotulo_evento_hora",
  rotulo_inicio: "op_rotulo_inicio",
  rotulo_fim: "op_rotulo_fim",
  rotulo_op_inicio: "op_rotulo_op_inicio",
  rotulo_op_fim: "op_rotulo_op_fim",
  vis_evento: "op_vis_evento",
  vis_endereco: "op_vis_endereco",
  vis_montagem: "op_vis_montagem",
  vis_caucao: "op_vis_caucao",
} as const;

export const ROTULO_KEY: Record<RotuloChave, string> = {
  evento: OPERACAO_KEYS.rotulo_evento,
  evento_hora: OPERACAO_KEYS.rotulo_evento_hora,
  inicio: OPERACAO_KEYS.rotulo_inicio,
  fim: OPERACAO_KEYS.rotulo_fim,
  operacao_inicio: OPERACAO_KEYS.rotulo_op_inicio,
  operacao_fim: OPERACAO_KEYS.rotulo_op_fim,
};

export const VIS_KEY: Record<VisChave, string> = {
  evento: OPERACAO_KEYS.vis_evento,
  endereco: OPERACAO_KEYS.vis_endereco,
  montagem: OPERACAO_KEYS.vis_montagem,
  caucao: OPERACAO_KEYS.vis_caucao,
};

/**
 * Perfis são MODELOS INICIAIS de configuração — nada além de valores prontos
 * que o administrador pode aplicar e depois ajustar individualmente.
 * Aplicar um perfil só grava estas preferências da empresa; nunca mexe em
 * reservas, orçamentos, estoque ou cobranças.
 */
export const PERFIS: Record<"festas" | "carretinhas", { rotulos: Rotulos; vis: Visibilidade }> = {
  festas: {
    rotulos: {
      evento: "Data e horário do evento",
      evento_hora: "Horário do evento",
      inicio: "Data e horário da entrega",
      fim: "Data e horário da retirada",
      operacao_inicio: "Entrega",
      operacao_fim: "Retirada",
    },
    vis: { evento: true, endereco: true, montagem: true, caucao: true },
  },
  carretinhas: {
    rotulos: {
      /* O campo de evento fica oculto neste perfil; o rótulo existe apenas
       * para o caso de a empresa religar a visibilidade depois. */
      evento: "Data e horário da retirada",
      evento_hora: "Horário da retirada",
      inicio: "Data e horário da retirada",
      fim: "Data e horário da devolução",
      operacao_inicio: "Retirada",
      operacao_fim: "Devolução",
    },
    vis: { evento: false, endereco: false, montagem: false, caucao: false },
  },
};

/** Configuração padrão — idêntica ao comportamento atual do sistema. */
export const OPERACAO_PADRAO: OperacaoConfig = {
  perfil: "festas",
  rotulos: { ...ROTULOS_PADRAO },
  vis: { ...VIS_PADRAO },
  personalizado: {
    evento: false,
    evento_hora: false,
    inicio: false,
    fim: false,
    operacao_inicio: false,
    operacao_fim: false,
    endereco: false,
    montagem: false,
    caucao: false,
  },
};

/* ------------------------------ resolver ----------------------------- */

type SettingsDe = Record<string, string | null | undefined>;

function mesmo(a: Rotulos, b: Rotulos): boolean {
  return (Object.keys(ROTULOS_PADRAO) as RotuloChave[]).every((k) => a[k] === b[k]);
}
function mesmaVis(a: Visibilidade, b: Visibilidade): boolean {
  return (Object.keys(VIS_PADRAO) as VisChave[]).every((k) => a[k] === b[k]);
}

/** Os valores efetivos batem com o preset deste perfil? */
export function valoresBatemComPerfil(
  perfil: "festas" | "carretinhas",
  rotulos: Rotulos,
  vis: Visibilidade,
): boolean {
  return mesmo(rotulos, PERFIS[perfil].rotulos) && mesmaVis(vis, PERFIS[perfil].vis);
}

/**
 * Fallback para empresas SEM `op_perfil` gravado (todas as que existem antes
 * desta chave): classifica pelos valores efetivos.
 *  - valores = preset de carretinhas → carretinhas
 *  - valores = preset de festas OU = padrão da plataforma → festas
 *  - qualquer outra combinação → personalizado
 */
export function classificarPerfil(rotulos: Rotulos, vis: Visibilidade): PerfilOperacional {
  if (valoresBatemComPerfil("carretinhas", rotulos, vis)) return "carretinhas";
  if (valoresBatemComPerfil("festas", rotulos, vis)) return "festas";
  if (mesmo(rotulos, ROTULOS_PADRAO) && mesmaVis(vis, VIS_PADRAO)) return "festas";
  return "personalizado";
}

function perfilSalvo(bruto: string | null | undefined): PerfilOperacional | null {
  const v = String(bruto ?? "").trim();
  return v === "festas" || v === "carretinhas" || v === "personalizado" ? v : null;
}

/**
 * Resolve a configuração operacional da empresa a partir das suas settings.
 * Chave ausente, vazia ou inválida cai no padrão da plataforma — uma empresa
 * sem nenhuma linha `op_*` vê exatamente o sistema de hoje.
 */
export function resolverOperacao(settings: SettingsDe): OperacaoConfig {
  const rotulos = {} as Rotulos;
  const personalizado = {} as OperacaoConfig["personalizado"];
  for (const k of Object.keys(ROTULOS_PADRAO) as RotuloChave[]) {
    const bruto = String(settings[ROTULO_KEY[k]] ?? "").trim();
    const valor = bruto || ROTULOS_PADRAO[k];
    rotulos[k] = valor;
    personalizado[k] = bruto !== "" && bruto !== ROTULOS_PADRAO[k];
  }
  const vis = {} as Visibilidade;
  for (const k of Object.keys(VIS_PADRAO) as VisChave[]) {
    const bruto = String(settings[VIS_KEY[k]] ?? "").trim();
    vis[k] = bruto === "" ? VIS_PADRAO[k] : bruto !== "0";
    personalizado[k] = vis[k] !== VIS_PADRAO[k];
  }
  const perfil = perfilSalvo(settings[OPERACAO_KEYS.perfil]) ?? classificarPerfil(rotulos, vis);
  return { perfil, rotulos, vis, personalizado };
}

/**
 * Texto de uma superfície que ainda usa o rótulo legado próprio.
 *
 * Enquanto a empresa NÃO personalizou o rótulo, cada tela continua exibindo
 * o texto que já exibia (orçamento fala "Entrega prevista", a reserva fala
 * "Entrega em"). Assim que o administrador personaliza, o rótulo da empresa
 * passa a valer em todas as superfícies.
 */
export function rotuloOu(config: OperacaoConfig, chave: RotuloChave, legado: string): string {
  return config.personalizado[chave] ? config.rotulos[chave] : legado;
}

/* --------------------- nomes das operações (início/fim) --------------- */

/** Plural simples para os títulos de menu/estatística ("Entrega"→"Entregas"). */
export function pluralizar(nome: string): string {
  const n = nome.trim();
  if (!n) return n;
  const minusculo = n.toLowerCase();
  if (minusculo.endsWith("ão")) return `${n.slice(0, -2)}ões`;
  if (minusculo.endsWith("rs") || minusculo.endsWith("z")) return `${n}s`;
  if (minusculo.endsWith("m")) return `${n.slice(0, -1)}ns`;
  if (minusculo.endsWith("s")) return `${n}es`;
  return `${n}s`;
}

function capitalizar(nome: string): string {
  return nome ? nome[0].toUpperCase() + nome.slice(1) : nome;
}

/**
 * Nome exibido de uma operação pelo TIPO interno ("entrega"/"retirada").
 * O tipo é domínio estável; só o texto acompanha a configuração da empresa.
 * Tipos que não são início/fim (montagem, desmontagem, frete…) devem usar o
 * rótulo do domínio — a função devolve null para sinalizar isso.
 */
export function nomeOperacao(config: OperacaoConfig, kind: string): string | null {
  if (kind === "entrega") return config.rotulos.operacao_inicio;
  if (kind === "retirada") return config.rotulos.operacao_fim;
  return null;
}

/** Título de menu/aba: "Entregas e Retiradas" por padrão, "Retiradas e Devoluções" em carretinhas. */
export function tituloOperacoes(config: OperacaoConfig): string {
  return `${pluralizar(config.rotulos.operacao_inicio)} e ${pluralizar(config.rotulos.operacao_fim)}`;
}

/** Rótulo da operação para os botões/estatísticas no plural ("Entregas"). */
export function nomeOperacoesPlural(config: OperacaoConfig, kind: "entrega" | "retirada"): string {
  return pluralizar(kind === "entrega" ? config.rotulos.operacao_inicio : config.rotulos.operacao_fim);
}

/**
 * Rótulos das notificações/filtros por TIPO, com a nomenclatura da empresa
 * para os tipos de operação de início/fim. As chaves (tipos internos)
 * permanecem as mesmas — só o texto exibido acompanha a configuração.
 */
export function tiposNotificacao(
  config: OperacaoConfig,
  tipos: Record<string, string>,
): Record<string, string> {
  return {
    ...tipos,
    entrega: nomeOperacoesPlural(config, "entrega"),
    retirada: nomeOperacoesPlural(config, "retirada"),
  };
}

/* ------------------------- status das reservas ------------------------ */

/**
 * Status de reserva com a nomenclatura da empresa para o fim da locação.
 *
 * "retirada" (status em que a locação terminou) e "aguardando_retirada"
 * acompanham o nome da operação final: festas continuam com "Retirada" e
 * "Aguardando retirada" (textos atuais); carretinhas mostram "Devolução" e
 * "Aguardando devolução". Os VALORES dos status não mudam — só o texto.
 */
export function statusReserva<T extends { value: string; label: string; tone: string }>(
  config: OperacaoConfig,
  defs: readonly T[],
): T[] {
  const fim = config.rotulos.operacao_fim;
  return defs.map((s) => {
    if (s.value === "retirada") return { ...s, label: capitalizar(fim) };
    if (s.value === "aguardando_retirada") return { ...s, label: `Aguardando ${fim.toLowerCase()}` };
    return s;
  });
}

/* --------------------------- data do evento -------------------------- */

/**
 * Data do evento quando o campo está oculto pela configuração da empresa.
 *
 * O campo interno continua estável: se a empresa não exibe "data do evento",
 * a data gravada deriva do INÍCIO da locação (nada é apagado nem duplicado —
 * é o mesmo dia, apenas preenchido pelo fluxo que o usuário realmente digitou).
 */
export function dataEventoOuInicio(
  eventDate: string | null | undefined,
  deliveryAt: string | null | undefined,
): string {
  const direto = String(eventDate ?? "").trim().slice(0, 10);
  if (direto) return direto;
  return String(deliveryAt ?? "").trim().slice(0, 10);
}

/* ------------------------------ validação ---------------------------- */

/** Tamanho máximo de um rótulo — evita quebrar formulários e documentos. */
export const TAMANHO_MAX_ROTULO = 60;

export type ResultadoOperacao =
  | { ok: true; values: Record<string, string> }
  | { ok: false; erro: string };

/**
 * Valida e normaliza o formulário do painel. Regras aplicadas NO SERVIDOR:
 * rótulos trimmed, sem caracteres de controle e com tamanho máximo; visibilidade
 * só aceita "1"; perfil precisa ser um dos três valores válidos. Valores vazios
 * de rótulo são apagados (voltam ao padrão da plataforma).
 *
 * Regra explícita do perfil: um PRESET escolhido com valores divergentes do
 * preset é gravado como "personalizado" — o perfil salvo nunca mente sobre o
 * que a empresa realmente usa. "Personalizado" escolhido é gravado como está,
 * mesmo coincidindo com um preset (é escolha explícita do administrador).
 */
export function validarOperacaoForm(dados: SettingsDe): ResultadoOperacao {
  const values: Record<string, string> = {};
  for (const k of Object.keys(ROTULOS_PADRAO) as RotuloChave[]) {
    const bruto = String(dados[ROTULO_KEY[k]] ?? "")
      // caracteres de controle (quebras de linha, NULs) nunca entram no rótulo
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .trim();
    if (bruto.length > TAMANHO_MAX_ROTULO) {
      return { ok: false, erro: `Rótulo muito longo (máximo ${TAMANHO_MAX_ROTULO} caracteres).` };
    }
    values[ROTULO_KEY[k]] = bruto;
  }
  for (const k of Object.keys(VIS_PADRAO) as VisChave[]) {
    // checkbox: presente com valor "1" = visível; ausente = oculto
    values[VIS_KEY[k]] = String(dados[VIS_KEY[k]] ?? "") === "1" ? "1" : "0";
  }

  const perfilEscolhido = perfilSalvo(dados[OPERACAO_KEYS.perfil]);
  if (!perfilEscolhido) return { ok: false, erro: "Perfil operacional inválido." };
  if (perfilEscolhido === "personalizado") {
    values[OPERACAO_KEYS.perfil] = "personalizado";
  } else {
    const efetivo = resolverOperacao(values);
    values[OPERACAO_KEYS.perfil] = valoresBatemComPerfil(perfilEscolhido, efetivo.rotulos, efetivo.vis)
      ? perfilEscolhido
      : "personalizado";
  }
  return { ok: true, values };
}
