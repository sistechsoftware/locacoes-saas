import "server-only";
import { getSettings, renderTemplate } from "./settings";
import { dateBR, money, timeBR, waLink } from "./format";

export type WaMessage = { key: string; label: string; href: string | null; text: string };

/**
 * Monta os links de WhatsApp com mensagem pre-preenchida.
 * A arquitetura isola a geracao da mensagem do meio de envio, de modo que a
 * troca do wa.me pela API oficial do WhatsApp Business exija mudar so aqui.
 */
export async function messagesForReservation(reservation: any, itemsSummary: string, balanceCents: number): Promise<WaMessage[]> {
  const s = await getSettings();
  const phone = reservation.customer_whatsapp || reservation.customer_phone;
  const vars = {
    cliente: (reservation.customer_name ?? "").split(" ")[0],
    empresa: s.company_name,
    reserva: reservation.number,
    data_evento: dateBR(reservation.event_date),
    hora_evento: reservation.event_time ?? "",
    hora_entrega: timeBR(reservation.delivery_at),
    hora_retirada: timeBR(reservation.pickup_at),
    endereco_evento: [reservation.address, reservation.district, reservation.city].filter(Boolean).join(", "),
    itens: itemsSummary,
    valor_total: money(reservation.total_cents),
    saldo: money(balanceCents),
    pix: s.pix_key || "(configure a chave Pix em Configurações)",
  };

  const build = (key: string, label: string, template: string): WaMessage => {
    const text = renderTemplate(template, vars);
    return { key, label, href: waLink(phone, text), text };
  };

  return [
    build("confirm", "Confirmação", s.wa_confirm),
    build("delivery", "Lembrete de entrega", s.wa_delivery),
    build("pickup", "Lembrete de retirada", s.wa_pickup),
    build("payment", "Cobrança de saldo", s.wa_payment),
  ];
}

export async function messageForQuote(quote: any, itemsSummary: string): Promise<WaMessage> {
  const s = await getSettings();
  const phone = quote.customer_whatsapp || quote.customer_phone;
  const text = renderTemplate(s.wa_quote, {
    cliente: (quote.customer_name ?? "").split(" ")[0],
    empresa: s.company_name,
    orcamento: quote.number,
    data_evento: dateBR(quote.event_date),
    itens: itemsSummary,
    valor_total: money(quote.total_cents),
  });
  return { key: "quote", label: "Enviar orçamento", href: waLink(phone, text), text };
}

export function plainMessage(phone: string | null | undefined, text: string): WaMessage {
  return { key: "livre", label: "WhatsApp", href: waLink(phone, text), text };
}
