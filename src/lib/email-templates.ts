/**
 * Templates de e-mail transacional — camada PURA, sem banco e sem rede.
 *
 * Identidade visual: a empresa LOCADORA, nunca a plataforma. O logotipo, o
 * nome comercial, o telefone/WhatsApp e a cor vêm de company_settings da
 * empresa DONA do registro que gerou o aviso; o rodapé identifica aquela
 * locadora (a plataforma só aparece na linha neutra de rodapé, sem assumir a
 * locação). Se um dado opcional faltar (logo, telefone, cidade), o layout
 * simplesmente omite a linha — o e-mail continua apresentável.
 *
 * Segurança: todo valor dinâmico passa por esc() antes de entrar no HTML
 * (cadastro do cliente não pode injetar marcação), e nenhum link carrega id
 * sequencial nem token: o único botão aponta para o portal do cliente, que
 * autentica por convite/primeiro acesso — nada de consulta pública por id.
 *
 * Financeiro fica DE FORA por padrão (minimização de dados): os e-mails trazem
 * cliente, locadora, data/horário, itens e quantidades — o que a pessoa precisa
 * para conferir a locação.
 */
import { esc } from "./contract-html";

/* ------------------------------------------------------------------ */
/* Tipos                                                               */
/* ------------------------------------------------------------------ */

export type IdentidadeEmail = {
  /** nome comercial da locadora (nunca "Locô" nem outra locadora) */
  nome: string;
  logo: string | null;
  telefone: string;
  whatsapp: string;
  endereco: string;
  cidade: string;
  email: string;
  /** cor de destaque da identidade visual (#RRGGBB) */
  cor: string;
  /** orientações comerciais cadastradas pela empresa */
  instrucoes: string;
  /** origem pública da plataforma, para o botão do portal */
  baseUrl: string;
};

export type ItemEmail = { nome: string; qtd: number };

export type ReservaEmail = {
  cliente: string;
  numero: string;
  dataEvento: string;
  horaEvento: string;
  inicio: string;
  fim: string;
  endereco: string;
  itens: ItemEmail[];
  /** rótulos operacionais da empresa: "Entrega"/"Retirada" ou "Retirada"/"Devolução" */
  rotuloInicio: string;
  rotuloFim: string;
  status: string;
  motivo: string;
  alteracoes: string[];
};

export type OperacaoEmail = {
  cliente: string;
  numero: string;
  /** rótulo da operação na empresa: Entrega, Retirada, Devolução, Montagem… */
  tipo: string;
  quando: string;
  endereco: string;
  status: string;
  obs: string;
};

export type FidelidadeEmail = {
  cliente: string;
  atual: number;
  meta: number;
  faltam: number;
  /** plural da unidade ("kits", "locações") */
  unidade: string;
  /** singular da mesma unidade ("kit", "locação") */
  unidadeSingular: string;
  beneficio: string;
  quando: string;
  condicoes: string[];
};

type Bloco = {
  assunto: string;
  titulo: string;
  paragrafos: string[];
  destaque?: { rotulo: string; valor: string };
  lista?: { titulo: string; itens: string[] }[];
  botao?: { href: string; label: string };
  extra?: string;
};

export type EmailMontado = { assunto: string; html: string; texto: string };

/* ------------------------------------------------------------------ */
/* Layout                                                              */
/* ------------------------------------------------------------------ */

const vazio = (v: unknown) => {
  const t = String(v ?? "").trim();
  return t;
};

/** Linha de contato/rodapé que só aparece quando a empresa cadastrou o dado. */
const condicional = (rotulo: string, valor: string) => (valor ? `<p style="margin:4px 0 0;font-size:13px;color:#4A4E57;">${rotulo}: <b>${esc(valor)}</b></p>` : "");

function montar(ident: IdentidadeEmail, b: Bloco): EmailMontado {
  const cor = ident.cor || "#C94F00";
  const logo = vazio(ident.logo)
    ? `<span style="display:inline-block;background:${cor};color:#ffffff;font-weight:800;font-size:16px;border-radius:10px;padding:6px 10px;">${esc((ident.nome || "L").trim().slice(0, 1).toUpperCase())}</span>`
    : `<img src="${esc(ident.logo!)}" alt="${esc(ident.nome)}" style="max-height:40px;max-width:180px;border-radius:8px;" />`;

  const destaque = b.destaque
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0;background:#FBF7F1;border:1px solid #EDE5D8;border-radius:12px;">
         <tr><td style="padding:14px 16px;">
           <p style="margin:0;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#6B7280;font-weight:700;">${esc(b.destaque.rotulo)}</p>
           <p style="margin:6px 0 0;font-size:16px;font-weight:800;color:#14161B;">${b.destaque.valor}</p>
         </td></tr>
       </table>`
    : "";

  const lista = b.lista?.length
    ? b.lista
        .filter((g) => g.itens.length)
        .map(
          (g) =>
            `<p style="margin:16px 0 6px;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#6B7280;font-weight:700;">${esc(
              g.titulo,
            )}</p>\n       <ul style="margin:0;padding-left:18px;font-size:14px;line-height:1.7;color:#4A4E57;">${g.itens
              .map((i) => `<li>${i}</li>`)
              .join("")}</ul>`,
        )
        .join("\n")
    : "";

  // sem origem pública configurada (dev local) o botao some: um link relativo
  // em e-mail e um link quebrado, e apontar para outro host exporia a plataforma.
  const botao = b.botao && /^https?:\/\//.test(b.botao.href)
    ? `<p style="margin:22px 0 4px;"><a href="${esc(b.botao.href)}" style="display:inline-block;background:${cor};color:#ffffff;text-decoration:none;font-weight:700;font-size:14px;border-radius:12px;padding:12px 20px;">${esc(
        b.botao.label,
      )}</a></p>`
    : "";

  const contato = [
    condicional("Telefone", ident.telefone),
    condicional("WhatsApp", ident.whatsapp),
    condicional("Endereço", ident.endereco),
    condicional("Cidade", ident.cidade),
    condicional("E-mail", ident.email),
  ]
    .join("")
    .trim();

  const instrucoes = ident.instrucoes
    ? `<p style="margin:18px 0 0;padding:12px 14px;background:#F6F3EC;border-radius:10px;font-size:13px;line-height:1.6;color:#4A4E57;"><b>Informações da locadora:</b> ${esc(ident.instrucoes)}</p>`
    : "";

  const html = `<!doctype html>
<html lang="pt-BR">
  <body style="margin:0;padding:0;background:#F6F3EC;font-family:Segoe UI,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F6F3EC;padding:24px 12px;">
      <tr><td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:540px;background:#ffffff;border:1px solid #DED8CD;border-radius:16px;">
          <tr><td style="padding:18px 24px;border-bottom:1px solid #EDE8DF;">
            ${logo}
            <span style="font-weight:800;color:#14161B;margin-left:10px;">${esc(ident.nome)}</span>
          </td></tr>
          <tr><td style="padding:24px;">
            <h1 style="margin:0 0 12px;font-size:18px;color:#14161B;">${esc(b.titulo)}</h1>
            <div style="font-size:14px;line-height:1.65;color:#4A4E57;">${b.paragrafos.map((p) => `<p style="margin:0 0 12px;">${p}</p>`).join("")}</div>
            ${destaque}
            ${lista}
            ${botao}
            ${b.extra ?? ""}
            ${instrucoes}
          </td></tr>
          <tr><td style="padding:16px 24px;border-top:1px solid #EDE8DF;font-size:12px;color:#6B7280;line-height:1.6;">
            <b>${esc(ident.nome)}</b>${ident.cidade ? ` · ${esc(ident.cidade)}` : ""}
            ${contato ? `<br/>${contato}` : ""}
            <br/>Este é um aviso automático da sua locação. Se você não esperava esta mensagem, ignore este e-mail.
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;

  const texto = [b.titulo, "", ...b.paragrafos.map((p) => p.replace(/<[^>]+>/g, "")), b.destaque ? `${b.destaque.rotulo}: ${b.destaque.valor.replace(/<[^>]+>/g, "")}` : "", b.lista?.length ? b.lista.flatMap((g) => g.itens).map((i) => `- ${String(i).replace(/<[^>]+>/g, "")}`).join("\n") : "", b.botao ? `\n${b.botao.label}: ${b.botao.href}` : ""]
    .filter((l) => l !== undefined)
    .join("\n")
    .trim();

  return { assunto: b.assunto, html, texto };
}

const link = (base: string) => `${base.replace(/\/$/, "")}/portal/login`;

/* ------------------------------------------------------------------ */
/* Itens e datas                                                       */
/* ------------------------------------------------------------------ */

const itemLinha = (i: ItemEmail) => `${esc(i.nome)} <b style="color:#14161B;">× ${Number(i.qtd) || 0}</b>`;

const listaItens = (itens: ItemEmail[]) =>
  itens.length ? [{ titulo: "Itens da locação", itens: itens.map(itemLinha) }] : [];

const quando = (data: string, hora: string) => (hora ? `${esc(data)} às <b>${esc(hora)}</b>` : esc(data));

/* ------------------------------------------------------------------ */
/* 1. Confirmação de reserva                                           */
/* ------------------------------------------------------------------ */

export function emailConfirmacaoReserva(ident: IdentidadeEmail, r: ReservaEmail): EmailMontado {
  return montar(ident, {
    assunto: `Reserva ${r.numero} confirmada — ${ident.nome}`,
    titulo: `Reserva confirmada, ${r.cliente}!`,
    paragrafos: [
      `Sua locação na <b>${esc(ident.nome)}</b> está <b>confirmada</b>. Confira os detalhes abaixo e confirme se está tudo certo.`,
    ],
    destaque: {
      rotulo: "Data do evento",
      valor: quando(r.dataEvento, r.horaEvento),
    },
    lista: [
      { titulo: "Reserva", itens: [`Número: <b>${esc(r.numero)}</b>`, `Status: <b>${esc(r.status)}</b>`] },
      {
        titulo: "Locação",
        itens: [
          `${esc(r.rotuloInicio)}: <b>${esc(r.inicio)}</b>`,
          `${esc(r.rotuloFim)}: <b>${esc(r.fim)}</b>`,
          ...(r.endereco ? [`Endereço do evento: ${esc(r.endereco)}`] : []),
        ],
      },
      { titulo: "Itens da locação", itens: r.itens.map(itemLinha) },
    ],
    botao: { href: link(ident.baseUrl), label: "Acessar meu portal" },
  });
}

/* ------------------------------------------------------------------ */
/* 2. Lembrete de reserva                                              */
/* ------------------------------------------------------------------ */

export function emailLembreteReserva(ident: IdentidadeEmail, r: ReservaEmail, antecedencia: string): EmailMontado {
  return montar(ident, {
    assunto: `Lembrete: sua locação ${r.numero} está marcada para ${r.dataEvento}`,
    titulo: `Sua locação está chegando, ${r.cliente}`,
    paragrafos: [
      `Este é um lembrete da <b>${esc(ident.nome)}</b>: sua locação <b>${esc(
        r.numero,
      )}</b> acontece ${antecedencia ? `<b>${esc(antecedencia)}</b> ` : ""}em <b>${quando(r.dataEvento, r.horaEvento)}</b>.`,
      `${esc(r.rotuloInicio)} prevista: <b>${esc(r.inicio)}</b> · ${esc(r.rotuloFim)} prevista: <b>${esc(r.fim)}</b>.`,
    ],
    destaque: r.endereco ? { rotulo: "Endereço do evento", valor: esc(r.endereco) } : undefined,
    lista: listaItens(r.itens),
    botao: { href: link(ident.baseUrl), label: "Acessar meu portal" },
  });
}

/* ------------------------------------------------------------------ */
/* 3. Alteração de reserva                                             */
/* ------------------------------------------------------------------ */

export function emailAlteracaoReserva(ident: IdentidadeEmail, r: ReservaEmail): EmailMontado {
  return montar(ident, {
    assunto: `Reserva ${r.numero} atualizada`,
    titulo: `Sua reserva foi atualizada, ${r.cliente}`,
    paragrafos: [
      `A <b>${esc(ident.nome)}</b> alterou a reserva <b>${esc(r.numero)}</b>. Veja o que mudou — os dados abaixo já são os vigentes.`,
    ],
    destaque: { rotulo: "Data atual do evento", valor: quando(r.dataEvento, r.horaEvento) },
    lista: [
      {
        titulo: "Alterações",
        itens: (r.alteracoes.length ? r.alteracoes : [`Status atual: ${r.status}`]).map(esc),
      },
    ],
    extra: `<p style="margin:14px 0 0;font-size:14px;color:#4A4E57;">${esc(r.rotuloInicio)}: <b>${esc(
      r.inicio,
    )}</b> · ${esc(r.rotuloFim)}: <b>${esc(r.fim)}</b></p>`,
    botao: { href: link(ident.baseUrl), label: "Acessar meu portal" },
  });
}

/* ------------------------------------------------------------------ */
/* 4. Cancelamento de reserva                                          */
/* ------------------------------------------------------------------ */

export function emailCancelamentoReserva(ident: IdentidadeEmail, r: ReservaEmail): EmailMontado {
  return montar(ident, {
    assunto: `Reserva ${r.numero} cancelada`,
    titulo: `Reserva cancelada, ${r.cliente}`,
    paragrafos: [
      `A reserva <b>${esc(r.numero)}</b> da <b>${esc(ident.nome)}</b> foi cancelada${
        r.motivo ? ` pelo motivo: <b>${esc(r.motivo)}</b>.` : "."
      }`,
      `Ela estava marcada para <b>${quando(r.dataEvento, r.horaEvento)}</b>.`,
      "Se este cancelamento não foi esperado, fale com a locadora pelos contatos abaixo.",
    ],
    botao: { href: link(ident.baseUrl), label: "Falar com a locadora" },
  });
}

/* ------------------------------------------------------------------ */
/* 5. Lembrete de operação (entrega / retirada)                        */
/* ------------------------------------------------------------------ */

export function emailLembreteOperacao(ident: IdentidadeEmail, o: OperacaoEmail, antecedencia: string): EmailMontado {
  return montar(ident, {
    assunto: `${o.tipo} prevista: ${o.quando}`,
    titulo: `${o.tipo} marcada, ${o.cliente}`,
    paragrafos: [
      `A <b>${esc(ident.nome)}</b> tem uma <b>${esc(o.tipo.toLowerCase())}</b> agendada ${
        antecedencia ? `<b>${esc(antecedencia)}</b> ` : ""
      }para <b>${esc(o.quando)}</b> — reserva <b>${esc(o.numero)}</b>.`,
      o.endereco ? `Endereço: <b>${esc(o.endereco)}</b>.` : "Se o endereço mudou, avise a locadora com antecedência.",
    ],
    destaque: { rotulo: o.tipo, valor: esc(o.quando) },
    botao: { href: link(ident.baseUrl), label: "Acessar meu portal" },
  });
}

/* ------------------------------------------------------------------ */
/* 6. Saída para a operação                                            */
/* ------------------------------------------------------------------ */

export function emailSaidaOperacao(ident: IdentidadeEmail, o: OperacaoEmail): EmailMontado {
  return montar(ident, {
    assunto: `Saiu para a ${o.tipo.toLowerCase()}: ${o.quando}`,
    titulo: `Equipe a caminho, ${o.cliente}`,
    paragrafos: [
      `A equipe da <b>${esc(ident.nome)}</b> <b>saiu para a ${esc(o.tipo.toLowerCase())}</b> da reserva <b>${esc(
        o.numero,
      )}</b>.`,
      `Previsão de chegada: <b>${esc(o.quando)}</b>.`,
    ],
    extra: o.obs ? `<p style="margin:12px 0 0;font-size:13px;color:#4A4E57;">Observação: ${esc(o.obs)}</p>` : "",
    botao: { href: link(ident.baseUrl), label: "Acessar meu portal" },
  });
}

/* ------------------------------------------------------------------ */
/* 7. Operação concluída                                               */
/* ------------------------------------------------------------------ */

export function emailOperacaoConcluida(ident: IdentidadeEmail, o: OperacaoEmail): EmailMontado {
  return montar(ident, {
    assunto: `${o.tipo} concluída — reserva ${o.numero}`,
    titulo: `${o.tipo} concluída, ${o.cliente}`,
    paragrafos: [
      `Registramos a conclusão da <b>${esc(o.tipo.toLowerCase())}</b> da reserva <b>${esc(
        o.numero,
      )}</b> na <b>${esc(ident.nome)}</b>.`,
      `Data do registro: <b>${esc(o.quando)}</b>.`,
      "Qualquer divergência, fale com a locadora — estamos à disposição.",
    ],
    botao: { href: link(ident.baseUrl), label: "Falar com a locadora" },
  });
}

/* ------------------------------------------------------------------ */
/* 8. Alteração de horário da operação                                 */
/* ------------------------------------------------------------------ */

export function emailAlteracaoOperacao(ident: IdentidadeEmail, o: OperacaoEmail): EmailMontado {
  return montar(ident, {
    assunto: `${o.tipo} da reserva ${o.numero} ${o.status === "Cancelada" ? "cancelada" : "reagendada"}`,
    titulo: `Atualização na ${o.tipo.toLowerCase()}, ${o.cliente}`,
    paragrafos: [
      o.status === "Cancelada"
        ? `A <b>${esc(o.tipo.toLowerCase())}</b> da reserva <b>${esc(o.numero)}</b> foi <b>cancelada</b>.`
        : `A <b>${esc(o.tipo.toLowerCase())}</b> da reserva <b>${esc(
            o.numero,
          )}</b> foi reagendada — novo horário abaixo.`,
    ],
    destaque: { rotulo: o.status === "Cancelada" ? "Situação" : "Novo horário", valor: esc(o.status === "Cancelada" ? "Cancelada" : o.quando) },
    extra: o.obs ? `<p style="margin:12px 0 0;font-size:13px;color:#4A4E57;">Observação: ${esc(o.obs)}</p>` : "",
    botao: { href: link(ident.baseUrl), label: "Falar com a locadora" },
  });
}

/* ------------------------------------------------------------------ */
/* 9. Operação em atraso                                               */
/* ------------------------------------------------------------------ */

export function emailOperacaoAtrasada(ident: IdentidadeEmail, o: OperacaoEmail): EmailMontado {
  return montar(ident, {
    assunto: `Atualização sobre a ${o.tipo.toLowerCase()} da reserva ${o.numero}`,
    titulo: `Sobre a sua ${o.tipo.toLowerCase()}, ${o.cliente}`,
    paragrafos: [
      `A <b>${esc(o.tipo.toLowerCase())}</b> da reserva <b>${esc(
        o.numero,
      )}</b> estava prevista para <b>${esc(o.quando)}</b> e ainda não foi concluída no sistema da <b>${esc(
        ident.nome,
      )}</b>.`,
      "Estamos ajustando o agendamento. Se precisar de uma posição sobre o prazo, fale com a locadora pelos contatos abaixo.",
    ],
    botao: { href: link(ident.baseUrl), label: "Falar com a locadora" },
  });
}

/* ------------------------------------------------------------------ */
/* 10. Avanço no programa de fidelidade                                */
/* ------------------------------------------------------------------ */

export function emailFidelidadeProgresso(ident: IdentidadeEmail, f: FidelidadeEmail): EmailMontado {
  const restam = Math.max(0, f.faltam);
  return montar(ident, {
    assunto: `Você já tem ${f.atual} de ${f.meta} no clube da ${ident.nome}`,
    titulo: `Bom trabalho, ${f.cliente}!`,
    paragrafos: [
      `Seu programa de fidelidade da <b>${esc(ident.nome)}</b> avançou: você já tem <b>${f.atual} ${
        f.unidade
      }(s)</b> e a meta é <b>${f.meta}</b>.`,
      restam > 0
        ? `Faltam <b>${restam}</b> para conquistar a recompensa.`
        : `Você bateu a meta — veja o benefício conquistado por aí.`,
    ],
    destaque: { rotulo: "Seu progresso", valor: `${f.atual} de ${f.meta} ${f.unidade}(s)` },
    botao: { href: link(ident.baseUrl), label: "Acessar meu portal" },
  });
}

/* ------------------------------------------------------------------ */
/* 11. Proximidade da recompensa                                       */
/* ------------------------------------------------------------------ */

export function emailFidelidadeQuaseLa(ident: IdentidadeEmail, f: FidelidadeEmail): EmailMontado {
  return montar(ident, {
    assunto: `Está quase! Falta ${f.faltam} para sua recompensa`,
    titulo: `Você está a um passo, ${f.cliente}`,
    paragrafos: [
      `Falta <b>${f.faltam}</b> ${f.unidade}(s) para você conquistar a recompensa do programa da <b>${esc(
        ident.nome,
      )}</b>.`,
      `Hoje você tem <b>${f.atual} de ${f.meta}</b>. Continue alugando para completar a meta.`,
    ],
    destaque: { rotulo: "Falta", valor: `${f.faltam} ${f.unidade}(s)` },
    botao: { href: link(ident.baseUrl), label: "Acessar meu portal" },
  });
}

/* ------------------------------------------------------------------ */
/* 12. Benefício conquistado                                           */
/* ------------------------------------------------------------------ */

export function emailFidelidadeConquista(ident: IdentidadeEmail, f: FidelidadeEmail): EmailMontado {
  return montar(ident, {
    assunto: `Recompensa conquistada na ${ident.nome}`,
    titulo: `Parabéns, ${f.cliente}! Você conquistou uma recompensa`,
    paragrafos: [
      `Você completou a meta do programa de fidelidade da <b>${esc(ident.nome)}</b> e ganhou: <b>${esc(
        f.beneficio,
      )}</b>.`,
      f.condicoes.length
        ? `Condições de uso combinadas pela locadora: ${f.condicoes.map((c) => `<b>${esc(c)}</b>`).join(" · ")}.`
        : `Para usar, é só falar com a locadora na próxima locação.`,
    ],
    destaque: { rotulo: "Benefício conquistado", valor: esc(f.beneficio) },
    botao: { href: link(ident.baseUrl), label: "Falar com a locadora" },
  });
}

/* ------------------------------------------------------------------ */
/* 13. Recompensa utilizada                                            */
/* ------------------------------------------------------------------ */

export function emailFidelidadeUso(ident: IdentidadeEmail, f: FidelidadeEmail): EmailMontado {
  return montar(ident, {
    assunto: `Recompensa utilizada — ${ident.nome}`,
    titulo: `Recompensa registrada, ${f.cliente}`,
    paragrafos: [
      `Utilizamos a recompensa <b>${esc(f.beneficio)}</b> na sua conta${
        f.quando ? `, em <b>${esc(f.quando)}</b>` : ""
      }.`,
      "Seu programa continua valendo para as próximas locações.",
    ],
    botao: { href: link(ident.baseUrl), label: "Acessar meu portal" },
  });
}

/* ------------------------------------------------------------------ */
/* 14. Recompensa prestes a vencer                                     */
/* ------------------------------------------------------------------ */

export function emailFidelidadeVencendo(ident: IdentidadeEmail, f: FidelidadeEmail): EmailMontado {
  return montar(ident, {
    assunto: `Sua recompensa vence em ${f.quando}`,
    titulo: `Atenção ao prazo da sua recompensa, ${f.cliente}`,
    paragrafos: [
      `A recompensa <b>${esc(f.beneficio)}</b> conquistada na <b>${esc(ident.nome)}</b> vence em <b>${esc(
        f.quando,
      )}</b>.`,
      "Fale com a locadora antes do prazo para usá-la.",
    ],
    botao: { href: link(ident.baseUrl), label: "Falar com a locadora" },
  });
}

/* ------------------------------------------------------------------ */
/* 15. E-mail de teste                                                 */
/* ------------------------------------------------------------------ */

/**
 * Teste enviado pela tela de configurações: usa APENAS dados fictícios
 * ("Cliente Exemplo", reserva "TESTE-0000") — nenhum cliente real é lido e
 * nenhum registro fictício é criado no banco.
 */
export function emailTeste(ident: IdentidadeEmail, destino: string): EmailMontado {
  return montar(ident, {
    assunto: `Teste de e-mail — ${ident.nome}`,
    titulo: `Configuração de e-mails funcionando`,
    paragrafos: [
      `Este é um e-mail de teste enviado pela configuração de notificações da <b>${esc(ident.nome)}</b>.`,
      `Destinatário informado: <b>${esc(destino)}</b>.`,
      "Nenhum cliente real foi consultado e nenhum registro de reserva foi criado para este envio.",
      "Se o visual, o remetente e os contatos abaixo estiverem corretos, os e-mails automáticos estão prontos para serem ativados.",
    ],
    destaque: { rotulo: "Modelo", valor: "Confirmação de reserva (dados fictícios)" },
    lista: [
      {
        titulo: "Amostra com dados fictícios",
        itens: [
          "Cliente: <b>Cliente Exemplo</b>",
          "Reserva: <b>TESTE-0000</b>",
          "Data do evento: <b>01/01/2099 às 10:00</b>",
          "Item: <b>Mesa × 10</b>",
        ],
      },
    ],
    botao: { href: link(ident.baseUrl), label: "Acessar meu portal" },
  });
}
