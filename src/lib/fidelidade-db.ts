import "server-only";
import { all, insert, one, run, scalar } from "./db";
import { getSettings, renderTemplate } from "./settings";
import { today, nowLocal, dateBR } from "./format";
import {
  aEmitir,
  beneficio,
  chaveEvento,
  expiraEm,
  elegivel,
  lembretesDeVencimento,
  EVENTOS,
  MODELOS_PADRAO,
  progresso,
  situacao,
  utilizavel,
  REGRA_PADRAO,
  type EventoFidelidade,
  type Regra,
} from "./fidelidade";

/**
 * Fidelidade: pontuacao, recompensas e avisos.
 *
 * A pontuacao e um livro-razao: cada locacao elegivel lanca uma linha, cancelar
 * lanca a reversao, e nada e apagado. O saldo e sempre somado do livro, nunca
 * guardado num contador, entao ele nao tem como divergir do historico.
 */

/** Configuracao vigente, lida das settings. */
export async function regraAtual(): Promise<Regra> {
  const s = await getSettings();
  const num = (chave: string, padrao: number) => {
    const v = Number(s[chave]);
    return Number.isFinite(v) ? v : padrao;
  };
  return {
    ativo: s.fidelity_active !== "0",
    meta: Math.max(1, num("fidelity_goal", REGRA_PADRAO.meta)),
    kits: Math.max(0, num("fidelity_kits", REGRA_PADRAO.kits)),
    validadeDias: Math.max(0, num("fidelity_validity_days", 0)),
    acumular: s.fidelity_accumulate !== "0",
    statusElegiveis: String(s.fidelity_eligible_status ?? "retirada,finalizada")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean),
    valorMinimoCents: Math.max(0, num("fidelity_min_value_cents", 0)),
    contarLocacaoGratuita: s.fidelity_count_free_rental === "1",
  };
}

/** Saldo de pontos do cliente, somado do livro-razao. */
export async function pontosDe(customerId: number): Promise<number> {
  return await scalar<number>(`SELECT COALESCE(SUM(delta),0) FROM fidelity_events WHERE customer_id = ?`, [customerId]);
}

export async function recompensasDe(customerId: number) {
  return await all<any>(
    `SELECT r.*, res.number AS reservation_number
       FROM fidelity_rewards r
       LEFT JOIN reservations res ON res.id = r.used_reservation_id
      WHERE r.customer_id = ? ORDER BY r.id DESC`,
    [customerId],
  );
}

export async function historicoDe(customerId: number) {
  return await all<any>(
    `SELECT e.*, r.number AS reservation_number
       FROM fidelity_events e LEFT JOIN reservations r ON r.id = e.reservation_id
      WHERE e.customer_id = ? ORDER BY e.id DESC LIMIT 100`,
    [customerId],
  );
}

/** Recompensas que o cliente pode usar hoje. */
export async function recompensasDisponiveis(customerId: number) {
  const d0 = today();
  const linhas = await all<any>(
    `SELECT * FROM fidelity_rewards WHERE customer_id = ? AND status = 'disponivel' ORDER BY
       CASE WHEN expires_on IS NULL THEN 1 ELSE 0 END, expires_on, id`,
    [customerId],
  );
  return linhas.filter((r) => utilizavel(r, d0));
}

/** Painel do cliente: progresso, recompensas e a regra que vale hoje. */
export async function painelDoCliente(customerId: number) {
  const [regra, pontos, recompensas] = await Promise.all([
    regraAtual(),
    pontosDe(customerId),
    recompensasDe(customerId),
  ]);
  const d0 = today();
  return {
    regra,
    progresso: progresso(pontos, regra),
    recompensas: recompensas.map((r: any) => ({ ...r, situacao: situacao(r, d0) })),
    disponiveis: recompensas.filter((r: any) => utilizavel(r, d0)),
  };
}

/* ------------------------------------------------------------------ */
/* Pontuacao                                                           */
/* ------------------------------------------------------------------ */

/**
 * Registra o ponto de uma locacao e emite recompensa se fechou a meta.
 *
 * Idempotente por construcao: a linha do livro tem UNIQUE por locacao, e a
 * emissao compara o devido com o ja emitido. Chamar duas vezes para a mesma
 * reserva nao gera ponto nem recompensa a mais.
 */
export async function pontuarReserva(reservationId: number, userId?: number): Promise<{
  pontuou: boolean;
  recompensasNovas: number[];
}> {
  const regra = await regraAtual();
  if (!regra.ativo) return { pontuou: false, recompensasNovas: [] };

  const reserva = await one<any>(
    `SELECT r.id, r.number, r.status, r.total_cents, r.customer_id,
            EXISTS (SELECT 1 FROM fidelity_rewards f WHERE f.used_reservation_id = r.id) AS usou_recompensa
       FROM reservations r WHERE r.id = ?`,
    [reservationId],
  );
  if (!reserva) return { pontuou: false, recompensasNovas: [] };

  const cabe = elegivel(
    {
      id: reserva.id,
      status: reserva.status,
      total_cents: reserva.total_cents,
      usou_recompensa: !!reserva.usou_recompensa,
    },
    regra,
  );
  if (!cabe) return { pontuou: false, recompensasNovas: [] };

  const jaTem = await one<any>(
    `SELECT id FROM fidelity_events WHERE reservation_id = ? AND kind = 'ponto'`,
    [reservationId],
  );
  if (!jaTem) {
    await insert(
      `INSERT INTO fidelity_events (customer_id, reservation_id, kind, delta, notes, created_by)
       VALUES (?,?,'ponto',1,?,?)`,
      [reserva.customer_id, reservationId, `Locacao ${reserva.number}`, userId ?? null],
    );
  }

  const novas = await emitirRecompensas(reserva.customer_id, regra, userId);
  return { pontuou: !jaTem, recompensasNovas: novas };
}

/**
 * Emite as recompensas que faltam para o cliente.
 *
 * O numero do ciclo e a chave: UNIQUE(customer_id, cycle) garante que duas
 * execucoes simultaneas nao consigam criar a mesma recompensa duas vezes.
 */
async function emitirRecompensas(customerId: number, regra: Regra, userId?: number): Promise<number[]> {
  const pontos = await pontosDe(customerId);
  const jaEmitidas = await scalar<number>(`SELECT COUNT(*) FROM fidelity_rewards WHERE customer_id = ?`, [customerId]);
  const quantas = aEmitir(pontos, jaEmitidas, regra);
  if (quantas <= 0) return [];

  const hoje = today();
  const criadas: number[] = [];
  for (let i = 0; i < quantas; i++) {
    const ciclo = jaEmitidas + i + 1;
    try {
      const id = await insert(
        `INSERT INTO fidelity_rewards (customer_id, kit_quantity, rule_goal, rule_validity_days, cycle, earned_at, expires_on)
         VALUES (?,?,?,?,?,?,?)`,
        [customerId, regra.kits, regra.meta, regra.validadeDias, ciclo, hoje, expiraEm(hoje, regra.validadeDias)],
      );
      criadas.push(id);
    } catch {
      // corrida com outra execucao: a recompensa daquele ciclo ja existe
    }
  }
  return criadas;
}

/**
 * Reverte a pontuacao de uma locacao cancelada.
 *
 * A linha original fica: entra uma reversao negativa. Recompensa ja usada nao
 * e mexida, porque o beneficio ja foi entregue; a que estiver so disponivel e
 * cancelada quando o saldo nao a sustenta mais.
 */
export async function reverterReserva(reservationId: number, userId?: number): Promise<boolean> {
  const reserva = await one<any>(`SELECT id, number, customer_id FROM reservations WHERE id = ?`, [reservationId]);
  if (!reserva) return false;

  const ponto = await one<any>(
    `SELECT id FROM fidelity_events WHERE reservation_id = ? AND kind = 'ponto'`,
    [reservationId],
  );
  const jaRevertido = await one<any>(
    `SELECT id FROM fidelity_events WHERE reservation_id = ? AND kind = 'reversao'`,
    [reservationId],
  );
  if (!ponto || jaRevertido) return false;

  await insert(
    `INSERT INTO fidelity_events (customer_id, reservation_id, kind, delta, notes, created_by)
     VALUES (?,?,'reversao',-1,?,?)`,
    [reserva.customer_id, reservationId, `Locacao ${reserva.number} cancelada`, userId ?? null],
  );

  const regra = await regraAtual();
  const pontos = await pontosDe(reserva.customer_id);
  const devidas = Math.floor(Math.max(0, pontos) / Math.max(1, regra.meta));
  // cancela da mais nova para a mais velha, e so as que ainda nao foram usadas
  const disponiveis = await all<any>(
    `SELECT id, cycle FROM fidelity_rewards WHERE customer_id = ? AND status = 'disponivel' ORDER BY cycle DESC`,
    [reserva.customer_id],
  );
  for (const r of disponiveis) {
    if (r.cycle > devidas) {
      await run(
        `UPDATE fidelity_rewards SET status='cancelada', notes=? WHERE id=? AND status='disponivel'`,
        [`Cancelada porque a locacao ${reserva.number} foi cancelada`, r.id],
      );
    }
  }
  return true;
}

/** Devolve a recompensa quando a locacao que a consumiu e cancelada. */
export async function devolverRecompensaDaReserva(reservationId: number): Promise<boolean> {
  const s = await getSettings();
  if (s.fidelity_return_on_cancel === "0") return false;
  const r = await one<any>(
    `SELECT id FROM fidelity_rewards WHERE used_reservation_id = ? AND status = 'usada'`,
    [reservationId],
  );
  if (!r) return false;
  await run(
    `UPDATE fidelity_rewards SET status='disponivel', used_at=NULL, used_reservation_id=NULL,
            used_kits=NULL, used_discount_cents=NULL, used_by=NULL,
            notes='Devolvida porque a locacao foi cancelada'
      WHERE id=?`,
    [r.id],
  );
  return true;
}

/* ------------------------------------------------------------------ */
/* Uso                                                                 */
/* ------------------------------------------------------------------ */

/** Quanto a recompensa cobriria desta reserva, sem gravar nada. */
export async function simularUso(rewardId: number, reservationId: number) {
  const recompensa = await one<any>(`SELECT * FROM fidelity_rewards WHERE id = ?`, [rewardId]);
  if (!recompensa) return null;
  const itens = await all<any>(
    `SELECT i.product_id, i.qty, i.unit_price_cents, p.kind
       FROM reservation_items i JOIN products p ON p.id = i.product_id
      WHERE i.reservation_id = ?`,
    [reservationId],
  );
  return beneficio(itens, recompensa.kit_quantity);
}

/**
 * Aplica a recompensa na reserva.
 *
 * O beneficio entra como desconto da reserva, que e o mecanismo de desconto que
 * ja existe: nao inventamos um segundo caminho para dinheiro sair.
 */
export async function usarRecompensa(
  rewardId: number,
  reservationId: number,
  userId?: number,
): Promise<string | null> {
  const d0 = today();
  const recompensa = await one<any>(`SELECT * FROM fidelity_rewards WHERE id = ?`, [rewardId]);
  if (!recompensa) return "Recompensa não encontrada.";
  if (!utilizavel(recompensa, d0)) return "Esta recompensa não está mais disponível.";

  const reserva = await one<any>(`SELECT id, customer_id, discount_cents FROM reservations WHERE id = ?`, [
    reservationId,
  ]);
  if (!reserva) return "Reserva não encontrada.";
  if (reserva.customer_id !== recompensa.customer_id) return "A recompensa é de outro cliente.";

  const b = await simularUso(rewardId, reservationId);
  if (!b || b.kitsGratis === 0) return "Esta reserva não tem kits para a recompensa cobrir.";

  // trava otimista: so aplica se a recompensa ainda estiver disponivel, entao
  // dois cliques simultaneos nao conseguem consumi-la duas vezes
  const marcou = await run(
    `UPDATE fidelity_rewards
        SET status='usada', used_at=?, used_reservation_id=?, used_kits=?, used_discount_cents=?, used_by=?
      WHERE id=? AND status='disponivel'`,
    [nowLocal(), reservationId, b.kitsGratis, b.descontoCents, userId ?? null, rewardId],
  );
  if (!marcou.meta.changes) return "Esta recompensa acabou de ser utilizada.";

  await run(
    `UPDATE reservations SET discount_cents = discount_cents + ?, updated_at = datetime('now','localtime') WHERE id = ?`,
    [b.descontoCents, reservationId],
  );
  const { recalcReservation } = await import("./reservations");
  await recalcReservation(reservationId);
  return null;
}

/* ------------------------------------------------------------------ */
/* Mensagens para o cliente                                            */
/* ------------------------------------------------------------------ */

async function modelo(evento: EventoFidelidade): Promise<string> {
  const s = await getSettings();
  return s[`fidelity_msg_${evento}`] || MODELOS_PADRAO[evento];
}

/**
 * Prepara uma mensagem para o cliente, uma unica vez por situacao.
 *
 * dedupe_key e o que impede o spam: atingir 4/5 gera um aviso, nao um por vez
 * que alguem abre a tela do cliente.
 */
export async function prepararMensagem(
  evento: EventoFidelidade,
  customerId: number,
  referencia: number | string,
  vars: Record<string, string | number | null | undefined>,
  rewardId?: number,
): Promise<number | null> {
  const s = await getSettings();
  const ligado: Record<string, string> = {
    progresso: "fidelity_notify_progress",
    quase_la: "fidelity_notify_almost",
    conquista: "fidelity_notify_earned",
    uso: "fidelity_notify_used",
    vencendo: "fidelity_notify_expiring",
    expirada: "fidelity_notify_expired",
    reversao: "fidelity_notify_used",
  };
  if (s[ligado[evento]] === "0") return null;

  const texto = renderTemplate(await modelo(evento), { empresa_nome: s.company_name, ...vars });
  try {
    return await insert(
      `INSERT INTO fidelity_messages (customer_id, reward_id, event, body, dedupe_key) VALUES (?,?,?,?,?)`,
      [customerId, rewardId ?? null, evento, texto, chaveEvento(evento, customerId, referencia)],
    );
  } catch {
    return null; // ja existe aviso para esta mesma situacao
  }
}

export async function mensagensPendentes(limite = 50) {
  return await all<any>(
    `SELECT m.*, c.name AS customer_name, c.phone, c.whatsapp
       FROM fidelity_messages m JOIN customers c ON c.id = m.customer_id
      WHERE m.status = 'pendente' ORDER BY m.id DESC LIMIT ?`,
    [limite],
  );
}

export async function mensagensDoCliente(customerId: number) {
  return await all<any>(
    `SELECT * FROM fidelity_messages WHERE customer_id = ? ORDER BY id DESC LIMIT 50`,
    [customerId],
  );
}

/* ------------------------------------------------------------------ */
/* Rotina diaria                                                       */
/* ------------------------------------------------------------------ */

/**
 * Expira recompensas vencidas e prepara os lembretes de vencimento.
 *
 * Roda no agendador que ja existe, entao o lembrete nao depende de ninguem
 * abrir o sistema.
 */
export async function rotinaDiaria(): Promise<{ expiradas: number; lembretes: number }> {
  const s = await getSettings();
  const regra = await regraAtual();
  if (!regra.ativo) return { expiradas: 0, lembretes: 0 };
  const d0 = today();

  const vencidas = await all<any>(
    `SELECT id, customer_id, kit_quantity, expires_on FROM fidelity_rewards
      WHERE status='disponivel' AND expires_on IS NOT NULL AND expires_on < ?`,
    [d0],
  );
  for (const r of vencidas) {
    await run(`UPDATE fidelity_rewards SET status='expirada' WHERE id=? AND status='disponivel'`, [r.id]);
    await prepararMensagem(
      "expirada",
      r.customer_id,
      r.id,
      { quantidade_kits: r.kit_quantity, data_expiracao: dateBR(r.expires_on) },
      r.id,
    );
  }

  let lembretes = 0;
  const antecedencias = lembretesDeVencimento(String(s.fidelity_expiry_reminders ?? ""));
  for (const dias of antecedencias) {
    const alvo = await all<any>(
      `SELECT r.id, r.customer_id, r.kit_quantity, r.expires_on, c.name AS customer_name
         FROM fidelity_rewards r JOIN customers c ON c.id = r.customer_id
        WHERE r.status='disponivel' AND r.expires_on = date(?, ?)`,
      [d0, `+${dias} days`],
    );
    for (const r of alvo) {
      const id = await prepararMensagem(
        "vencendo",
        r.customer_id,
        `${r.id}:${dias}`,
        {
          cliente_nome: (r.customer_name ?? "").split(" ")[0],
          quantidade_kits: r.kit_quantity,
          data_expiracao: dateBR(r.expires_on),
        },
        r.id,
      );
      if (id) lembretes++;
    }
  }

  return { expiradas: vencidas.length, lembretes };
}

/* ------------------------------------------------------------------ */
/* Gatilho de negocio                                                  */
/* ------------------------------------------------------------------ */

/**
 * Chamado quando a locacao muda de status.
 *
 * Pontua se agora ela conta, emite recompensa se fechou a meta e prepara os
 * avisos. Tudo idempotente: passar pelo mesmo status duas vezes nao duplica
 * ponto, recompensa nem mensagem.
 */
export async function aoConcluirLocacao(reservationId: number, userId?: number) {
  const regra = await regraAtual();
  if (!regra.ativo) return;

  const { pontuou, recompensasNovas } = await pontuarReserva(reservationId, userId);
  if (!pontuou && recompensasNovas.length === 0) return;

  const reserva = await one<any>(
    `SELECT r.id, r.number, r.customer_id, c.name AS customer_name
       FROM reservations r JOIN customers c ON c.id = r.customer_id WHERE r.id = ?`,
    [reservationId],
  );
  if (!reserva) return;

  const primeiroNome = String(reserva.customer_name ?? "").split(" ")[0];
  const pontos = await pontosDe(reserva.customer_id);
  const p = progresso(pontos, regra);

  const base = {
    cliente_nome: primeiroNome,
    locacoes_realizadas: p.noCiclo === 0 && p.pontos > 0 ? regra.meta : p.noCiclo,
    locacoes_necessarias: regra.meta,
    locacoes_restantes: p.faltam,
    quantidade_kits: regra.kits,
    numero_locacao: reserva.number,
  };

  for (const rewardId of recompensasNovas) {
    await avisarEquipe(
      "conquista",
      `${primeiroNome} conquistou uma recompensa de até ${regra.kits} kits grátis`,
      reserva.customer_id,
      rewardId,
    );
    await prepararMensagem("conquista", reserva.customer_id, rewardId, base, rewardId);
  }

  if (recompensasNovas.length === 0 && pontuou) {
    // avisa "falta 1" uma unica vez por ciclo, e nao a cada visita a tela
    if (p.faltam === 1) {
      await avisarEquipe(
        "quase_la",
        `${primeiroNome} está a 1 locação de ganhar até ${regra.kits} kits grátis`,
        reserva.customer_id,
        p.ciclosCompletos + 1,
      );
      await prepararMensagem("quase_la", reserva.customer_id, p.ciclosCompletos + 1, base);
    } else {
      await prepararMensagem("progresso", reserva.customer_id, `${p.ciclosCompletos}:${p.noCiclo}`, base);
    }
  }
}

/**
 * Aviso interno para a equipe, na central de notificacoes que ja existe.
 *
 * Reaproveita user_notifications: e a mesma caixa que ja recebe entrega,
 * retirada e vencimento, entao a equipe nao precisa aprender um lugar novo.
 */
export async function avisarEquipe(
  evento: EventoFidelidade,
  texto: string,
  customerId: number,
  referencia: number | string,
) {
  const usuarios = await all<{ id: number }>(`SELECT id FROM users WHERE active = 1`);
  for (const u of usuarios) {
    try {
      await insert(
        `INSERT INTO user_notifications (user_id, event_id, type, title, body, link, created_at)
         VALUES (?,NULL,'fidelidade',?,?,?,unixepoch())`,
        [u.id, EVENTOS[evento], texto, `/clientes/${customerId}`],
      );
    } catch {
      // UNIQUE(user_id, event_id) nao cobre event_id nulo; duplicata aqui e inofensiva
    }
  }
}

/* ------------------------------------------------------------------ */
/* Importacao do historico                                             */
/* ------------------------------------------------------------------ */

export type ResumoImportacao = {
  locacoes: number;
  clientes: number;
  recompensas: number;
  porCliente: { customer_id: number; name: string; locacoes: number; recompensas: number }[];
};

/**
 * Traz para o programa as locacoes que ja tinham sido concluidas.
 *
 * Sem isso o cliente de oito festas comeca do zero no dia em que o programa
 * entra no ar, o que e exatamente o oposto de um programa de fidelidade.
 *
 * Duas cautelas guiam o desenho. A primeira e que nada aqui avisa ninguem:
 * pontuar dez anos de historico de uma vez dispararia uma mensagem por cliente,
 * e o programa estrearia como spam. A segunda e que rodar de novo nao pode
 * duplicar: o UNIQUE por locacao ja barra o ponto repetido, e a recompensa
 * continua saindo da conta entre devido e emitido.
 */
export async function importarHistorico(opts: { simular?: boolean; userId?: number } = {}): Promise<ResumoImportacao> {
  const regra = await regraAtual();
  const marcas = regra.statusElegiveis.map(() => "?").join(",") || "''";

  // uma consulta para todo o historico: nada de percorrer reserva por reserva
  const condicao = `
      FROM reservations r JOIN customers c ON c.id = r.customer_id
     WHERE r.status IN (${marcas})
       AND r.total_cents >= ?
       AND NOT EXISTS (SELECT 1 FROM fidelity_events e WHERE e.reservation_id = r.id AND e.kind = 'ponto')
       ${regra.contarLocacaoGratuita ? "" : "AND NOT EXISTS (SELECT 1 FROM fidelity_rewards f WHERE f.used_reservation_id = r.id)"}`;
  const params = [...regra.statusElegiveis, regra.valorMinimoCents];

  const pendentes = await all<any>(
    `SELECT r.customer_id, c.name, COUNT(*) AS locacoes ${condicao} GROUP BY r.customer_id, c.name ORDER BY locacoes DESC`,
    params,
  );

  const previsao: ResumoImportacao["porCliente"] = [];
  for (const p of pendentes) {
    const atuais = await pontosDe(p.customer_id);
    const emitidas = await scalar<number>(`SELECT COUNT(*) FROM fidelity_rewards WHERE customer_id = ?`, [
      p.customer_id,
    ]);
    previsao.push({
      customer_id: p.customer_id,
      name: p.name,
      locacoes: p.locacoes,
      recompensas: aEmitir(atuais + p.locacoes, emitidas, regra),
    });
  }

  const resumo: ResumoImportacao = {
    locacoes: pendentes.reduce((s: number, p: any) => s + p.locacoes, 0),
    clientes: pendentes.length,
    recompensas: previsao.reduce((s, p) => s + p.recompensas, 0),
    porCliente: previsao,
  };
  if (opts.simular) return resumo;

  await run(
    `INSERT OR IGNORE INTO fidelity_events (customer_id, reservation_id, kind, delta, notes, created_by)
     SELECT r.customer_id, r.id, 'ponto', 1, 'Locacao ' || r.number || ' (historico importado)', ?
     ${condicao}`,
    [opts.userId ?? null, ...params],
  );

  // as recompensas saem em silencio: o aviso e escolha da empresa, cliente a
  // cliente, e nao um disparo para a base inteira
  for (const p of previsao) {
    await emitirRecompensas(p.customer_id, regra, opts.userId);
  }
  return resumo;
}
