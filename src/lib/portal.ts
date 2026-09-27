import "server-only";
import { all, one } from "./db";
import { ACTIVE_STATUSES, HOLDING_STATUSES } from "./domain";
import { getCustomer } from "./queries";
import { painelDoCliente, historicoDe } from "./fidelidade-db";
import { reservationItems, reservationMoney, reservationOperations } from "./reservations";
import { getSettings } from "./settings";
import { today } from "./format";

/**
 * Leitura de dados PARA O PORTAL DO CLIENTE.
 *
 * Nenhuma regra nova de negocio mora aqui: fidelidade vem de painelDoCliente
 * (fidelidade-db), financeiro das mesmas tabelas que o Financeiro usa e os
 * status vem das constantes de domain.ts. O portal so da uma lente de
 * privacidade por cima — toda funcao recebe o customerId da SESSAO e filtra
 * por ele; nenhum id chega do navegador.
 */

const ACTIVE = ACTIVE_STATUSES.map((s) => `'${s}'`).join(",");
/** Status que o cliente entende como "ja aconteceu". */
const PASSADOS = `('retirada','finalizada')`;
/**
 * Reservas futuras de verdade, pela definicao que o sistema ja usa:
 * HOLDING_STATUSES (pre_reserva..aguardando_retirada) sao os status em que a
 * reserva ainda ocupa estoque — uma locacao finalizada, mesmo com data no
 * futuro por erro de cadastro, nao e "a proxima" de ninguem.
 */
const FUTURAS = HOLDING_STATUSES.map((s) => `'${s}'`).join(",");

export type ReservaPortal = {
  id: number;
  number: string;
  status: string;
  event_date: string;
  event_time: string | null;
  delivery_at: string | null;
  pickup_at: string | null;
  address: string | null;
  district: string | null;
  city: string | null;
  total_cents: number;
  discount_cents: number;
  paid_cents: number;
  usou_recompensa: boolean;
  contou_fidelidade: boolean;
};

/** Dados cadastrais que o proprio cliente pode ver sobre si. */
export async function perfilDoCliente(customerId: number) {
  const c = await getCustomer(customerId);
  if (!c) return null;
  return {
    id: c.id,
    name: c.name,
    doc: c.doc,
    phone: c.phone,
    whatsapp: c.whatsapp,
    email: c.email,
    address: c.address,
    district: c.district,
    city: c.city,
    zip: c.zip,
    birth_date: c.birth_date,
    created_at: c.created_at,
    // indicadores que ja existiam no sistema (CUSTOMER_SELECT)
    locacoes: c.locacoes,
    canceladas: c.canceladas,
    total_cents: c.total_cents,
    saldo_cents: c.saldo_cents,
    ultima: c.ultima,
    proxima: c.proxima,
  };
}

/**
 * Historico de reservas/locacoes do cliente, com as marcas de fidelidade.
 *
 * `usou_recompensa` vem de fidelity_rewards.used_reservation_id (a mesma fonte
 * que elegivel() usa para nao pontuar) e `contou_fidelidade` vem do
 * livro-razao fidelity_events — a MESMA fonte que painelDoCliente soma. O que
 * o cliente ve aqui bate exatamente com o progresso do ciclo.
 */
export async function reservasDoCliente(customerId: number, limite = 100): Promise<ReservaPortal[]> {
  const rows = await all<any>(
    `SELECT r.id, r.number, r.status, r.event_date, r.event_time, r.delivery_at, r.pickup_at,
            r.address, r.district, r.city, r.total_cents, r.discount_cents,
            (SELECT COALESCE(SUM(p.amount_cents),0) FROM payments p WHERE p.reservation_id = r.id) AS paid_cents,
            EXISTS (SELECT 1 FROM fidelity_rewards f WHERE f.used_reservation_id = r.id) AS usou_recompensa,
            EXISTS (SELECT 1 FROM fidelity_events e WHERE e.reservation_id = r.id AND e.kind = 'ponto') AS contou_fidelidade
       FROM reservations r
      WHERE r.customer_id = ?
      ORDER BY r.event_date DESC, r.id DESC
      LIMIT ?`,
    [customerId, limite],
  );
  return rows.map((r) => ({
    id: r.id,
    number: r.number,
    status: r.status,
    event_date: r.event_date,
    event_time: r.event_time ?? null,
    delivery_at: r.delivery_at ?? null,
    pickup_at: r.pickup_at ?? null,
    address: r.address ?? null,
    district: r.district ?? null,
    city: r.city ?? null,
    total_cents: Number(r.total_cents ?? 0),
    discount_cents: Number(r.discount_cents ?? 0),
    paid_cents: Number(r.paid_cents ?? 0),
    usou_recompensa: !!r.usou_recompensa,
    contou_fidelidade: !!r.contou_fidelidade,
  }));
}

/** Uma reserva do cliente, para a tela de detalhes. Nunca de outro cliente. */
export async function reservaDoCliente(customerId: number, reservaId: number) {
  const todas = await reservasDoCliente(customerId, 100000);
  const r = todas.find((x) => x.id === reservaId);
  if (!r) return null;
  const [itens, financeiro, operacoes] = await Promise.all([
    reservationItems(reservaId),
    reservationMoney(reservaId),
    reservationOperations(reservaId),
  ]);
  return {
    reserva: r,
    itens: itens.map((i) => ({ name: i.product_name, qty: i.qty, kind: i.product_kind, subtotal: i.subtotal_cents })),
    financeiro,
    operacoes: operacoes.map((o) => ({ kind: o.kind, status: o.status, scheduled_at: o.scheduled_at })),
  };
}

/**
 * Resumo financeiro do cliente.
 *
 * Total gasto soma `total_cents` das reservas em status ativos — a MESMA conta
 * do indicador "Total gasto" que a equipe ja ve no cadastro do cliente
 * (CUSTOMER_SELECT), entao portal e sistema interno nunca divergem. Pago vem
 * da tabela payments, saldo = total - pago.
 */
export async function financeiroDoCliente(customerId: number) {
  const r = await one<any>(
    `SELECT
       (SELECT COALESCE(SUM(total_cents),0) FROM reservations WHERE customer_id = ?1 AND status IN (${ACTIVE})) AS total_cents,
       (SELECT COUNT(*) FROM reservations WHERE customer_id = ?1 AND status IN (${ACTIVE})) AS locacoes_ativas,
       (SELECT COUNT(*) FROM reservations WHERE customer_id = ?1 AND status IN ${PASSADOS}) AS locacoes_concluidas,
       (SELECT COALESCE(SUM(p.amount_cents),0)
          FROM payments p JOIN reservations r ON r.id = p.reservation_id
         WHERE r.customer_id = ?1) AS pago_cents,
       (SELECT COUNT(*) FROM payments p JOIN reservations r ON r.id = p.reservation_id
         WHERE r.customer_id = ?1) AS qtd_pagamentos,
       (SELECT MAX(p.paid_at) FROM payments p JOIN reservations r ON r.id = p.reservation_id
         WHERE r.customer_id = ?1) AS ultimo_pagamento`,
    [customerId],
  );
  const total = Number(r?.total_cents ?? 0);
  const pago = Number(r?.pago_cents ?? 0);
  return {
    total_cents: total,
    pago_cents: pago,
    saldo_cents: Math.max(0, total - pago),
    locacoes_ativas: Number(r?.locacoes_ativas ?? 0),
    locacoes_concluidas: Number(r?.locacoes_concluidas ?? 0),
    qtd_pagamentos: Number(r?.qtd_pagamentos ?? 0),
    ultimo_pagamento: r?.ultimo_pagamento ?? null,
  };
}

export type ContratoPortal = {
  id: number;
  number: string;
  status: string;
  reservation_id: number;
  reservation_number: string | null;
  event_date: string | null;
  total_cents: number;
  created_at: string;
  signed_at: string | null;
  signer_name: string | null;
  /** Assinatura digital deste contrato (a mais recente), campos planos. */
  assinatura_id: number | null;
  assinatura_status: string | null;
  assinatura_signed_at: string | null;
};

/**
 * Contratos do cliente, digitais e "de papel" lado a lado.
 *
 * Um contrato e DIGITAL quando existe contract_signatures com status
 * 'assinado' (fonte: assinatura-db). Os demais aparecem como estao no fluxo
 * interno (pendente/enviado/assinado manual/encerrado/cancelado). Reutiliza
 * tudo que ja existe; nada e duplicado.
 */
export async function contratosDoCliente(customerId: number): Promise<ContratoPortal[]> {
  return await all<any>(
    `SELECT ct.id, ct.number, ct.status, ct.created_at, ct.signed_at, ct.signer_name,
            r.id AS reservation_id, r.number AS reservation_number, r.event_date, r.total_cents,
            (SELECT a.id FROM contract_signatures a
              WHERE a.contract_id = ct.id AND a.status = 'assinado'
              ORDER BY a.id DESC LIMIT 1) AS assinatura_id,
            (SELECT a.signed_at FROM contract_signatures a
              WHERE a.contract_id = ct.id AND a.status = 'assinado'
              ORDER BY a.id DESC LIMIT 1) AS assinatura_signed_at,
            (SELECT a.status FROM contract_signatures a
              WHERE a.contract_id = ct.id
              ORDER BY a.id DESC LIMIT 1) AS assinatura_status
       FROM contracts ct
       JOIN reservations r ON r.id = ct.reservation_id
      WHERE r.customer_id = ?
      ORDER BY ct.id DESC
      LIMIT 100`,
    [customerId],
  );
}

/**
 * Atribui o documento digitalizado (contrato assinado no papel) a partir do
 * historico documental que ja existe (customer_documents, source
 * 'upload_manual' com contract_id ou reservation_id).
 */
export async function documentosDoPortal(customerId: number) {
  return await all<any>(
    `SELECT d.id, d.title, d.source, d.file_id, d.mime, d.size, d.notes, d.created_at,
            d.contract_id, d.reservation_id, d.signature_id,
            ct.number AS contract_number, r.number AS reservation_number,
            a.signed_at AS assinatura_signed_at
       FROM customer_documents d
       LEFT JOIN contracts ct ON ct.id = d.contract_id
       LEFT JOIN reservations r ON r.id = d.reservation_id
       LEFT JOIN contract_signatures a ON a.id = d.signature_id
      WHERE d.customer_id = ?
      ORDER BY d.id DESC`,
    [customerId],
  );
}

/** Proxima reserva futura do cliente (nao cancelada, data de hoje em diante). */
export async function proximaReserva(customerId: number) {
  const d0 = today();
  return await one<any>(
    `SELECT r.id, r.number, r.event_date, r.event_time, r.delivery_at, r.pickup_at,
            r.address, r.district, r.city, r.status, r.total_cents,
            (SELECT COALESCE(SUM(i.qty),0) FROM reservation_items i WHERE i.reservation_id = r.id) AS itens_qty,
            (SELECT group_concat(i.qty || 'x ' || p.name, ', ')
               FROM reservation_items i JOIN products p ON p.id = i.product_id
              WHERE i.reservation_id = r.id) AS itens
       FROM reservations r
      WHERE r.customer_id = ? AND r.event_date >= ? AND r.status IN (${FUTURAS})
      ORDER BY r.event_date, r.id
      LIMIT 1`,
    [customerId, d0],
  );
}

/** Avisos e contatos configurados pela equipe (settings portal_*). */
export async function configuracaoPortal() {
  const s = await getSettings();
  return {
    empresa: s.company_name,
    tagline: s.company_tagline,
    logo: s.company_logo,
    aviso: s.portal_public_notice ?? "",
    whatsapp: s.portal_whatsapp || s.company_whatsapp || "",
    telefone: s.portal_contact_phone || s.company_phone || "",
    email: s.portal_contact_email || s.company_email || "",
    pix: s.pix_key ?? "",
  };
}

/** Ultima locacao concluida, para o card do dashboard. */
export async function ultimaLocacao(customerId: number) {
  return await one<any>(
    `SELECT r.id, r.number, r.event_date, r.total_cents, r.status
       FROM reservations r
      WHERE r.customer_id = ? AND r.status IN ${PASSADOS}
      ORDER BY r.event_date DESC, r.id DESC
      LIMIT 1`,
    [customerId],
  );
}
