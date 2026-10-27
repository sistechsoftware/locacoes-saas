/**
 * Catálogo dos e-mails automáticos e da configuração POR EMPRESA.
 *
 * Camada PURA (sem "server-only"): os mesmos valores alimentam a tela de
 * Configurações > Notificações, o agendador do cron, os testes e o histórico.
 *
 * Onde a configuração mora: em `company_settings`, pelas chaves `email_*` da
 * whitelist de src/lib/settings.ts — o mesmo KV multi-tenant de fidelidade,
 * operação e aniversários. NÃO existe tabela nova de configuração: uma empresa
 * nunca lê, escreve ou desativa a configuração de outra.
 *
 * Regra de ligação: master (`email_enabled`) E grupo (`email_grupo_*`) E tipo
 * (`email_<tipo>`) precisam estar ligados. O master nasce DESLIGADO: nenhum
 * envio real começa a existir sozinho em produção — alguém liga, por empresa.
 */
import { fusoValido } from "./email-tempo";

export type GrupoEmail = "reservas" | "operacoes" | "fidelidade";

export type TipoEmail =
  | "reserva_confirmacao"
  | "reserva_lembrete"
  | "reserva_alteracao"
  | "reserva_cancelamento"
  | "operacao_lembrete"
  | "operacao_saida"
  | "operacao_concluida"
  | "operacao_alteracao"
  | "operacao_atrasada"
  | "fidelidade_progresso"
  | "fidelidade_quase_la"
  | "fidelidade_conquista"
  | "fidelidade_uso"
  | "fidelidade_vencendo"
  | "email_teste";

export type DefinicaoTipo = {
  grupo: GrupoEmail;
  rotulo: string;
  descricao: string;
  /** true = lembrete com antecedência configurável (chave de antecedências). */
  lembrete?: boolean;
  /** chave em company_settings; ausente = `email_<tipo>`. */
  chave?: string;
  /** ligado por padrão quando a empresa ainda não gravou nada. */
  padrao: boolean;
};

export const GRUPOS_EMAIL: Record<GrupoEmail, { rotulo: string; descricao: string }> = {
  reservas: {
    rotulo: "Reservas",
    descricao: "Confirmações, lembretes, alterações e cancelamentos de reserva.",
  },
  operacoes: {
    rotulo: "Entregas e retiradas",
    descricao: "Lembretes e status das operações de início e fim da locação.",
  },
  fidelidade: {
    rotulo: "Programa de fidelidade",
    descricao: "Avanço, proximidade da recompensa, conquista e uso do benefício.",
  },
};

export const TIPOS_EMAIL: Record<TipoEmail, DefinicaoTipo> = {
  reserva_confirmacao: {
    grupo: "reservas",
    rotulo: "Confirmação de reserva",
    descricao: "Enviado quando a reserva muda para Confirmada.",
    padrao: true,
  },
  reserva_lembrete: {
    grupo: "reservas",
    rotulo: "Lembrete de reserva",
    descricao: "Lembra o cliente da data da reserva com a antecedência configurada.",
    lembrete: true,
    padrao: true,
  },
  reserva_alteracao: {
    grupo: "reservas",
    rotulo: "Alteração de reserva",
    descricao: "Avisa mudança de data, horário, itens ou status da reserva.",
    padrao: true,
  },
  reserva_cancelamento: {
    grupo: "reservas",
    rotulo: "Cancelamento de reserva",
    descricao: "Avisa que a reserva foi cancelada.",
    padrao: true,
  },
  operacao_lembrete: {
    grupo: "operacoes",
    rotulo: "Lembrete de operação",
    descricao: "Lembrete da operação de início/fim com a antecedência configurada.",
    lembrete: true,
    padrao: true,
  },
  operacao_saida: {
    grupo: "operacoes",
    rotulo: "Saída para a operação",
    descricao: "Avisa que a equipe saiu para realizar a operação (status Em rota).",
    padrao: true,
  },
  operacao_concluida: {
    grupo: "operacoes",
    rotulo: "Operação concluída",
    descricao: "Confirma a conclusão da operação registrada no sistema.",
    padrao: true,
  },
  operacao_alteracao: {
    grupo: "operacoes",
    rotulo: "Alteração de horário",
    descricao: "Avisa reagendamento ou cancelamento de uma operação.",
    padrao: true,
  },
  operacao_atrasada: {
    grupo: "operacoes",
    rotulo: "Operação em atraso",
    descricao: "Avisa quando a data prevista passou e a operação continua em aberto.",
    padrao: false,
  },
  fidelidade_progresso: {
    grupo: "fidelidade",
    rotulo: "Avanço no programa",
    descricao: "Enviado quando o cliente soma um ponto válido no programa.",
    padrao: true,
  },
  fidelidade_quase_la: {
    grupo: "fidelidade",
    rotulo: "Proximidade da recompensa",
    descricao: "Enviado quando falta a quantidade configurada para a meta.",
    padrao: true,
  },
  fidelidade_conquista: {
    grupo: "fidelidade",
    rotulo: "Benefício conquistado",
    descricao: "Enviado quando o cliente fecha a meta e ganha a recompensa.",
    padrao: true,
  },
  fidelidade_uso: {
    grupo: "fidelidade",
    rotulo: "Recompensa utilizada",
    descricao: "Enviado quando uma recompensa é registrada como usada.",
    padrao: true,
  },
  fidelidade_vencendo: {
    grupo: "fidelidade",
    rotulo: "Recompensa prestes a vencer",
    descricao: "Lembrete de validade de recompensa conquistada.",
    padrao: true,
  },
  email_teste: {
    grupo: "reservas",
    rotulo: "E-mail de teste",
    descricao: "Disparado manualmente pela tela de configurações, sem dados de cliente.",
    padrao: true,
    chave: "email_teste",
  },
};

export const TIPOS_DO_GRUPO = (g: GrupoEmail): TipoEmail[] =>
  (Object.keys(TIPOS_EMAIL) as TipoEmail[]).filter((t) => TIPOS_EMAIL[t].grupo === g);

/** Chave em company_settings deste tipo (`email_<tipo>`, salvo override). */
export function chaveDoTipo(tipo: TipoEmail): string {
  return TIPOS_EMAIL[tipo]?.chave ?? `email_${tipo}`;
}

/* ------------------------------------------------------------------ */
/* Valores e antecedências                                             */
/* ------------------------------------------------------------------ */

/** Limite de antecedências por tipo: evita fila inflada com dezenas de avisos. */
export const MAX_ANTECEDENCIAS = 4;
/** Antecedência máxima (14 dias) e mínima (5 minutos), em minutos. */
export const MIN_ANTECEDENCIA = 5;
export const MAX_ANTECEDENCIA = 14 * 24 * 60;

export const PADRAO_ANTECEDENCIA_RESERVA = "4320,1440"; // 3 dias e 1 dia
export const PADRAO_ANTECEDENCIA_OPERACAO = "1440,120"; // 1 dia e 2 horas

/**
 * Lê uma lista de antecedências em minutos a partir de um CSV.
 * Valor inválido (letra, negativo, fora da faixa, excedente) cai no padrão —
 * a configuração quebrada nunca silencia o tipo nem vira fila infinita.
 */
export function parseAntecedencias(valor: unknown, padrao: string): number[] {
  const bruto = typeof valor === "string" ? valor : "";
  const lista = bruto
    .split(",")
    .map((t) => Number(t.trim()))
    .filter((n) => Number.isFinite(n) && Number.isInteger(n) && n >= MIN_ANTECEDENCIA && n <= MAX_ANTECEDENCIA);
  const unicos = [...new Set(lista)].sort((a, b) => b - a);
  if (!unicos.length) return parseAntecedencias(padrao, "");
  return unicos.slice(0, MAX_ANTECEDENCIAS);
}

export function antecedenciasValidas(valor: unknown): boolean {
  const bruto = typeof valor === "string" ? valor : "";
  const partes = bruto.split(",").map((t) => t.trim()).filter(Boolean);
  if (!partes.length) return false;
  if (partes.length > MAX_ANTECEDENCIAS) return false;
  return partes.every((p) => {
    const n = Number(p);
    return Number.isInteger(n) && n >= MIN_ANTECEDENCIA && n <= MAX_ANTECEDENCIA;
  });
}

/** "08:00" é válido; qualquer outra coisa cai no padrão. */
export function horaValida(valor: unknown): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(valor ?? "").trim());
}

/** Cor de destaque em hex curto ou longo; fora disso, o padrão da marca. */
export function corValida(valor: unknown): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(String(valor ?? "").trim());
}

/* ------------------------------------------------------------------ */
/* Configuração resolvida                                              */
/* ------------------------------------------------------------------ */

export type ConfigEmail = {
  ativo: boolean;
  grupos: Record<GrupoEmail, boolean>;
  tipos: Record<TipoEmail, boolean>;
  antecedenciaReserva: number[];
  antecedenciaOperacao: number[];
  /** quantas unidades faltando ainda contam como "proximo da recompensa" */
  quaseLaLimite: number;
  horaEnvio: string;
  fuso: string;
  cor: string;
  /** orientações comerciais da locadora repetidas no rodapé dos e-mails */
  instrucoes: string;
};

const liga = (s: Record<string, string>, chave: string, padrao: boolean): boolean => {
  const v = s[chave];
  if (v === undefined || v === null || v === "") return padrao;
  return v !== "0";
};

/**
 * Resolve a configuração de uma empresa a partir do próprio mapa de settings.
 * Pura: as mesmas entradas produzem sempre a mesma saída (testável sem banco).
 *
 * Chave ausente = comportamento padrão documentado aqui; a empresa que nunca
 * abriu a tela de Notificações não envia nada porque o master nasce desligado.
 */
export function resolverConfigEmail(s: Record<string, string>): ConfigEmail {
  const tipos = {} as Record<TipoEmail, boolean>;
  for (const t of Object.keys(TIPOS_EMAIL) as TipoEmail[]) {
    tipos[t] = liga(s, chaveDoTipo(t), TIPOS_EMAIL[t].padrao);
  }
  const limite = Math.trunc(Number(s.email_fidelidade_quase_la_limite));
  return {
    ativo: s.email_enabled === "1",
    grupos: {
      reservas: liga(s, "email_grupo_reservas", true),
      operacoes: liga(s, "email_grupo_operacoes", true),
      fidelidade: liga(s, "email_grupo_fidelidade", true),
    },
    tipos,
    antecedenciaReserva: parseAntecedencias(s.email_reserva_lembrete_antecedencias, PADRAO_ANTECEDENCIA_RESERVA),
    antecedenciaOperacao: parseAntecedencias(s.email_operacao_lembrete_antecedencias, PADRAO_ANTECEDENCIA_OPERACAO),
    quaseLaLimite: Number.isFinite(limite) && limite >= 1 ? Math.min(limite, 999) : 1,
    horaEnvio: horaValida(s.email_hora_envio) ? String(s.email_hora_envio).trim() : "08:00",
    fuso: fusoValido(s.email_fuso) ? String(s.email_fuso).trim() : "America/Sao_Paulo",
    cor: corValida(s.email_cor) ? String(s.email_cor).trim() : "#C94F00",
    instrucoes: String(s.email_instrucoes ?? "").slice(0, 500),
  };
}

/**
 * Este tipo está ligado (master + grupo + tipo)?
 *
 * `email_teste` é ação manual da tela de configurações: independente dos
 * interruptores, para permitir conferir o visual ANTES de ligar o envio real.
 */
export function tipoLigado(cfg: ConfigEmail, tipo: TipoEmail): boolean {
  if (!TIPOS_EMAIL[tipo]) return false;
  if (tipo === "email_teste") return true;
  if (!cfg.ativo) return false;
  if (!cfg.grupos[TIPOS_EMAIL[tipo].grupo]) return false;
  return cfg.tipos[tipo] !== false;
}

/** Antecedências aplicáveis a um tipo (só os tipos lembrete as têm). */
export function antecedenciasDe(cfg: ConfigEmail, tipo: TipoEmail): number[] {
  if (tipo === "reserva_lembrete") return cfg.antecedenciaReserva;
  if (tipo === "operacao_lembrete") return cfg.antecedenciaOperacao;
  return [];
}

/* ------------------------------------------------------------------ */
/* Situação para a tela de resumo                                      */
/* ------------------------------------------------------------------ */

export type AvisoConfig = { chave: string; texto: string };

/**
 * Configuração incompleta ou desativada, para a tela de resumo mostrar o que
 * impede o envio — sem depender de ninguém ler o banco.
 */
export function avisosDeConfiguracao(cfg: ConfigEmail, emailConfigurado: boolean): AvisoConfig[] {
  const avisos: AvisoConfig[] = [];
  if (!cfg.ativo) {
    avisos.push({ chave: "master", texto: "E-mails automáticos desativados para esta empresa." });
  }
  if (!emailConfigurado) {
    avisos.push({
      chave: "provedor",
      texto: "Remetente/credencial do provedor não configurados no Worker (RESEND_API_KEY / RESEND_FROM).",
    });
  }
  if (cfg.ativo && !cfg.grupos.reservas) avisos.push({ chave: "reservas", texto: "Grupo Reservas desativado." });
  if (cfg.ativo && !cfg.grupos.operacoes) avisos.push({ chave: "operacoes", texto: "Grupo Entregas e retiradas desativado." });
  if (cfg.ativo && !cfg.grupos.fidelidade) avisos.push({ chave: "fidelidade", texto: "Grupo Fidelidade desativado." });
  if (cfg.ativo && !cfg.antecedenciaReserva.length && !cfg.tipos.reserva_lembrete) {
    avisos.push({ chave: "lembretes", texto: "Nenhum lembrete de reserva configurado." });
  }
  return avisos;
}
