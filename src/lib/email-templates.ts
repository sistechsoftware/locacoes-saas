/**
 * Templates de e-mail transacional — camada PURA, sem banco e sem rede.
 *
 * Identidade visual: a empresa LOCADORA, nunca a plataforma. A logo, o nome
 * comercial, o documento, os contatos, a cidade e a cor vêm de
 * company_settings da empresa DONA do registro que gerou o aviso.
 *
 * Cabeçalho: quando a empresa tem logo cadastrada, ela entra em tamanho
 * discreto (altura fixa, proporção preservada) e absolutizada na rota pública —
 * ver src/lib/email-identidade.ts. Sem logo (ou com imagem não servível), entra
 * o monograma que o e-mail já usava como alternativa. O nome da empresa aparece
 * SEMPRE ao lado, então o cliente identifica o remetente mesmo se a imagem não
 * carregar (cliente de e-mail que bloqueia imagem remota).
 *
 * Rodapé: a mesma identidade dos PDFs de reserva/orçamento — nome, CNPJ/CPF,
 * contatos e endereço da empresa, barra na cor da marca e leitura em coluna
 * única (celular). As orientações comerciais da empresa, quando existirem,
 * ficam ali, e não no meio da mensagem.
 *
 * Personalização: cada função aceita um `PersonalizacaoEmail` opcional com o
 * modelo salvo pela empresa e o mapa de variáveis do evento. Os textos padrão
 * (assunto/título/parágrafos) são substituídos pelos da empresa, mas os blocos
 * de DADOS (data em destaque, itens, botão) continuam vindo do sistema — o
 * e-mail nunca perde a informação correta só porque o texto foi personalizado.
 *
 * Compatibilidade: tabelas + CSS inline (Gmail, Outlook, Apple Mail, apps
 * móveis), sem flexbox/grid, sem JavaScript, sem folha externa. A media query
 * só ajusta espaçamento em telas pequenas; o layout já é de coluna única.
 *
 * Segurança: todo valor dinâmico passa por esc()/escaparHtml antes do HTML, e a
 * personalização da empresa é TEXTO (nunca HTML livre). Nenhum link carrega id
 * sequencial nem token: o botão aponta para o portal do cliente, que autentica
 * por convite/primeiro acesso.
 */
import { esc } from "./contract-html";
import { monogramaEmpresa } from "./email-identidade";
import {
  aplicarVariaveis,
  chavesUsadas,
  paragrafosDeHtml,
  soTexto,
  type PersonalizacaoEmail,
} from "./email-variaveis";

/* ------------------------------------------------------------------ */
/* Tipos                                                               */
/* ------------------------------------------------------------------ */

export type IdentidadeEmail = {
  /** nome comercial da locadora (nunca "Locô" nem outra locadora) */
  nome: string;
  /** URL ABSOLUTA e pública da logo; null quando não há imagem servível */
  logo: string | null;
  telefone: string;
  whatsapp: string;
  endereco: string;
  cidade: string;
  email: string;
  /** CNPJ/CPF já formatado, quando cadastrado */
  documento?: string;
  /** subtítulo/assinatura comercial da empresa */
  tagline?: string;
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
  /* Só preenchidos quando a empresa personalizou o modelo (variáveis). */
  clienteCompleto?: string;
  clienteEmail?: string;
  clienteTelefone?: string;
  valorTotal?: string;
  valorAdiantamento?: string;
  valorPendente?: string;
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
  clienteCompleto?: string;
  clienteEmail?: string;
  clienteTelefone?: string;
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
  clienteCompleto?: string;
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

export type { PersonalizacaoEmail };

/* ------------------------------------------------------------------ */
/* Paleta e helpers                                                    */
/* ------------------------------------------------------------------ */

const TINTA = "#14161B";
const TEXTO = "#4A4E57";
const SUAVE = "#6B7280";
const FRACO = "#8A8F98";
const FUNDO = "#F4F1EA";
const BORDA = "#E3DDD1";
const FUNDO_BLOCO = "#FAF8F4";
const FONTE = "'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif";

const vazio = (v: unknown) => String(v ?? "").trim();
const corSegura = (v: string) => (/^#[0-9a-fA-F]{6}$/.test(String(v ?? "").trim()) ? String(v).trim() : "#C94F00");

/** Linha de contato do rodapé: só existe quando a empresa cadastrou o dado. */
const linhaContato = (rotulo: string, valor: string) =>
  vazio(valor)
    ? `<p style="margin:6px 0 0;font-size:12px;line-height:1.5;color:${TEXTO};"><span style="color:${SUAVE};">${esc(
        rotulo,
      )}:</span> <b style="color:${TINTA};">${esc(valor)}</b></p>`
    : "";

/**
 * Cabeçalho do e-mail.
 *
 * A logo fica em uma célula de largura mínima (`width:1%` + `nowrap`) para não
 * ser esticada pela tabela vizinha; só a ALTURA é fixa, então a largura
 * acompanha a proporção original. `alt` com o nome da empresa é o fallback de
 * quem bloqueia imagens — e o nome ao lado torna o remetente inequívoco.
 */
function cabecalho(ident: IdentidadeEmail, cor: string): string {
  const nome = vazio(ident.nome) || "Locadora";
  const logo = ident.logo
    ? `<img src="${esc(ident.logo)}" alt="${esc(nome)}" height="40" style="display:block;height:40px;width:auto;max-height:40px;max-width:170px;border:0;outline:none;text-decoration:none;" />`
    : `<span style="display:inline-block;background:${cor};color:#ffffff;font-family:${FONTE};font-weight:800;font-size:17px;line-height:1;border-radius:10px;padding:11px 13px;">${esc(
        monogramaEmpresa(nome),
      )}</span>`;

  const subtitulo = vazio(ident.tagline)
    ? `<div style="margin-top:4px;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:${SUAVE};font-family:${FONTE};">${esc(
        ident.tagline!,
      )}</div>`
    : "";

  return `<tr><td style="background:${cor};height:4px;line-height:4px;font-size:0;">&nbsp;</td></tr>
          <tr><td class="email-cabecalho" style="padding:20px 24px;border-bottom:1px solid ${BORDA};background:#ffffff;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td valign="middle" width="1%" style="width:1%;white-space:nowrap;">${logo}</td>
                <td valign="middle" style="padding-left:14px;">
                  <div style="font-size:16px;font-weight:800;line-height:1.25;color:${TINTA};font-family:${FONTE};">${esc(
                    nome,
                  )}</div>
                  ${subtitulo}
                </td>
              </tr>
            </table>
          </td></tr>`;
}

/**
 * Rodapé na mesma linguagem do cabeçalho dos PDFs de reserva/orçamento:
 * barra na cor da empresa, nome, documento, contatos, endereço e cidade.
 * Coluna única de propósito — no celular não há coluna comprimida.
 */
function rodape(ident: IdentidadeEmail, cor: string): string {
  const nome = vazio(ident.nome) || "Locadora";
  const endereco = [vazio(ident.endereco), vazio(ident.cidade)].filter(Boolean).join(" · ");

  const contatos = [
    linhaContato("Telefone", ident.telefone),
    linhaContato("WhatsApp", ident.whatsapp),
    linhaContato("E-mail", ident.email),
  ]
    .join("")
    .trim();

  const documento = vazio(ident.documento)
    ? `<p style="margin:3px 0 0;font-size:12px;line-height:1.5;color:${SUAVE};">CNPJ/CPF: ${esc(ident.documento!)}</p>`
    : "";

  const enderecoLinha = endereco
    ? `<p style="margin:6px 0 0;font-size:12px;line-height:1.5;color:${TEXTO};">${esc(endereco)}</p>`
    : "";

  const instrucoes = vazio(ident.instrucoes)
    ? `<p style="margin:14px 0 0;padding:12px 14px;background:#ffffff;border:1px solid ${BORDA};border-radius:10px;font-size:12px;line-height:1.6;color:${TEXTO};font-family:${FONTE};">${esc(
        ident.instrucoes,
      )}</p>`
    : "";

  return `<tr><td style="padding:0 24px;background:${FUNDO_BLOCO};"><div style="height:2px;background:${cor};font-size:0;line-height:0;">&nbsp;</div></td></tr>
          <tr><td class="email-rodape" style="background:${FUNDO_BLOCO};padding:18px 24px 20px;">
            <p style="margin:0;font-size:14px;font-weight:800;line-height:1.3;color:${TINTA};font-family:${FONTE};">${esc(
              nome,
            )}</p>
            ${documento}
            ${contatos}
            ${enderecoLinha}
            ${instrucoes}
          </td></tr>
          <tr><td style="padding:14px 24px 18px;background:#ffffff;border-top:1px solid ${BORDA};">
            <p style="margin:0;font-size:11px;line-height:1.6;color:${FRACO};font-family:${FONTE};">
              Você recebeu este e-mail porque é cliente da ${esc(nome)}.
              Se não reconhece este contato, fale com a empresa pelos canais acima.
            </p>
          </td></tr>`;
}

function botaoHtml(href: string, label: string, cor: string): string {
  // sem origem pública o botão some: link relativo em e-mail é link quebrado.
  if (!/^https?:\/\//i.test(href)) return "";
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:22px 0 4px;">
            <tr><td align="center" bgcolor="${cor}" style="border-radius:12px;mso-padding-alt:12px 22px;">
              <a href="${esc(href)}" style="display:inline-block;padding:12px 22px;font-family:${FONTE};font-size:14px;font-weight:700;line-height:1.2;color:#ffffff;text-decoration:none;border-radius:12px;">${esc(
                label,
              )}</a>
            </td></tr>
          </table>`;
}

/**
 * Monta o HTML final. `perso` é o modelo da empresa + as variáveis do evento:
 * presente, os textos do modelo substituem os padrões; os blocos de dados
 * permanecem.
 */
function montar(ident: IdentidadeEmail, b: Bloco, perso?: PersonalizacaoEmail): EmailMontado {
  const cor = corSegura(ident.cor);
  const modelo = perso?.modelo ?? {};
  const vars = perso?.vars ?? {};

  const assuntoCustom = vazio(modelo.assunto) ? aplicarVariaveis(modelo.assunto, vars, { escapar: false }) : "";
  const assunto = vazio(assuntoCustom) || b.assunto;

  const tituloCustom = vazio(modelo.titulo) ? aplicarVariaveis(modelo.titulo, vars, { escapar: false }) : "";
  const titulo = vazio(tituloCustom) || b.titulo;

  const temCorpoCustom = [modelo.abertura, modelo.corpo, modelo.complemento].some((v) => vazio(v));
  const corpoCustom = temCorpoCustom
    ? [
        ...paragrafosDeHtml(modelo.abertura ?? "", vars),
        ...paragrafosDeHtml(modelo.corpo ?? "", vars),
        ...paragrafosDeHtml(modelo.complemento ?? "", vars),
      ]
    : [];
  const paragrafos = corpoCustom.length ? corpoCustom : b.paragrafos;

  // A lista de itens do sistema só sai quando o modelo não trouxe a sua:
  // assim o cliente nunca vê a mesma relação duas vezes.
  const usaItensNoModelo = chavesUsadas(modelo.corpo ?? "").includes("reserva_itens");
  const lista = usaItensNoModelo ? [] : b.lista ?? [];

  const assinatura = vazio(modelo.assinatura) ? paragrafosDeHtml(modelo.assinatura, vars).join("") : "";
  const extra = [assinatura, b.extra ?? ""].filter(Boolean).join("");

  const destaque = b.destaque
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:18px 0;background:#FBF7F1;border:1px solid ${BORDA};border-left:3px solid ${cor};border-radius:10px;">
         <tr><td style="padding:14px 16px;">
           <p style="margin:0;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:${SUAVE};font-weight:700;font-family:${FONTE};">${esc(
             b.destaque.rotulo,
           )}</p>
           <p style="margin:6px 0 0;font-size:16px;font-weight:800;color:${TINTA};font-family:${FONTE};">${b.destaque.valor}</p>
         </td></tr>
       </table>`
    : "";

  const listaHtml = lista
    .filter((g) => g.itens.length)
    .map(
      (g) =>
        `<p style="margin:18px 0 6px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:${SUAVE};font-weight:700;font-family:${FONTE};">${esc(
          g.titulo,
        )}</p>
         <ul style="margin:0;padding-left:18px;font-size:14px;line-height:1.75;color:${TEXTO};font-family:${FONTE};">${g.itens
           .map((i) => `<li style="margin:0 0 2px;">${i}</li>`)
           .join("")}</ul>`,
    )
    .join("");

  const botao = b.botao ? botaoHtml(b.botao.href, b.botao.label, cor) : "";

  const preheader = soTexto(paragrafos[0] ?? "").replace(/\s+/g, " ").trim().slice(0, 140);

  const html = `<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <meta http-equiv="X-UA-Compatible" content="IE=edge" />
    <meta name="x-apple-disable-message-reformatting" />
    <title>${esc(titulo)}</title>
    <style>
      /* Ajuste fino para telas pequenas: o layout base já é de coluna única. */
      @media only screen and (max-width:480px) {
        .email-cabecalho { padding:16px 18px !important; }
        .email-corpo { padding:20px 18px !important; }
        .email-rodape { padding:16px 18px !important; }
        .email-titulo { font-size:17px !important; }
      }
    </style>
  </head>
  <body style="margin:0;padding:0;width:100%;background:${FUNDO};-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">
    ${
      preheader
        ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;font-size:1px;line-height:1px;">${esc(
            preheader,
          )}</div>`
        : ""
    }
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${FUNDO};padding:24px 12px;">
      <tr><td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:#ffffff;border:1px solid ${BORDA};border-radius:16px;">
          ${cabecalho(ident, cor)}
          <tr><td class="email-corpo" style="padding:26px 24px 22px;">
            <h1 class="email-titulo" style="margin:0 0 14px;font-size:19px;line-height:1.35;color:${TINTA};font-family:${FONTE};">${esc(
              titulo,
            )}</h1>
            <div style="font-size:14px;line-height:1.65;color:${TEXTO};font-family:${FONTE};">${paragrafos.join("")}</div>
            ${destaque}
            ${listaHtml}
            ${botao}
            ${extra}
          </td></tr>
          ${rodape(ident, cor)}
        </table>
      </td></tr>
    </table>
  </body>
</html>`;

  const texto = [
    titulo,
    "",
    ...paragrafos.map(soTexto),
    b.destaque ? `${b.destaque.rotulo}: ${soTexto(b.destaque.valor)}` : "",
    ...lista.flatMap((g) => [g.titulo, ...g.itens.map((i) => `- ${soTexto(i)}`)]),
    b.botao ? `${b.botao.label}: ${b.botao.href}` : "",
    extra ? soTexto(extra) : "",
    "",
    `${vazio(ident.nome) || "Locadora"}${ident.telefone ? ` · ${ident.telefone}` : ""}${
      ident.email ? ` · ${ident.email}` : ""
    }`,
  ]
    .filter((l) => l !== undefined)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { assunto, html, texto };
}

const link = (base: string) => `${String(base ?? "").replace(/\/$/, "")}/portal/login`;

/* ------------------------------------------------------------------ */
/* Itens, datas e unidades                                             */
/* ------------------------------------------------------------------ */

const itemLinha = (i: ItemEmail) =>
  `${esc(i.nome)} <b style="color:${TINTA};">× ${Number(i.qtd) || 0}</b>`;

const listaItens = (itens: ItemEmail[]) =>
  itens.length ? [{ titulo: "Itens da locação", itens: itens.map(itemLinha) }] : [];

const quando = (data: string, hora: string) => (hora && hora !== "-" ? `${esc(data)} às <b>${esc(hora)}</b>` : esc(data));

/** "1 kit"/"3 kits" — sem `(s)`, que é o que soa de robô. */
export function unidadeFidelidade(qtd: number, f: FidelidadeEmail): string {
  return Math.abs(Number(qtd) || 0) === 1 ? f.unidadeSingular : f.unidade;
}

/* ------------------------------------------------------------------ */
/* 1. Confirmação de reserva                                           */
/* ------------------------------------------------------------------ */

export function emailConfirmacaoReserva(ident: IdentidadeEmail, r: ReservaEmail, perso?: PersonalizacaoEmail): EmailMontado {
  return montar(
    ident,
    {
      assunto: `Reserva ${r.numero} confirmada — ${ident.nome}`,
      titulo: `Sua reserva está confirmada, ${r.cliente}`,
      paragrafos: [
        `A <b>${esc(ident.nome)}</b> confirmou a sua locação. Confira os detalhes abaixo e avise se algo precisar de ajuste.`,
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
    },
    perso,
  );
}

/* ------------------------------------------------------------------ */
/* 2. Lembrete de reserva                                              */
/* ------------------------------------------------------------------ */

export function emailLembreteReserva(
  ident: IdentidadeEmail,
  r: ReservaEmail,
  antecedencia: string,
  perso?: PersonalizacaoEmail,
): EmailMontado {
  const distancia = vazio(antecedencia) ? ` em <b>${esc(antecedencia)}</b>` : "";
  return montar(
    ident,
    {
      assunto: `Sua locação ${r.numero} acontece em ${r.dataEvento}`,
      titulo: `Está chegando, ${r.cliente}`,
      paragrafos: [
        `Passando para lembrar da sua locação com a <b>${esc(
          ident.nome,
        )}</b>: reserva <b>${esc(r.numero)}</b>, ${quando(r.dataEvento, r.horaEvento)}.`,
        `A ${esc(r.rotuloInicio.toLowerCase())} está prevista para <b>${esc(
          r.inicio,
        )}</b> e a ${esc(r.rotuloFim.toLowerCase())} para <b>${esc(r.fim)}</b>.`,
        `Se precisar mudar algo${distancia}, fale com a gente o quanto antes.`,
      ],
      destaque: r.endereco ? { rotulo: "Endereço do evento", valor: esc(r.endereco) } : undefined,
      lista: listaItens(r.itens),
      botao: { href: link(ident.baseUrl), label: "Acessar meu portal" },
    },
    perso,
  );
}

/* ------------------------------------------------------------------ */
/* 3. Alteração de reserva                                             */
/* ------------------------------------------------------------------ */

export function emailAlteracaoReserva(ident: IdentidadeEmail, r: ReservaEmail, perso?: PersonalizacaoEmail): EmailMontado {
  return montar(
    ident,
    {
      assunto: `Reserva ${r.numero} atualizada — ${ident.nome}`,
      titulo: `Sua reserva foi atualizada, ${r.cliente}`,
      paragrafos: [
        `A <b>${esc(
          ident.nome,
        )}</b> atualizou a reserva <b>${esc(r.numero)}</b>. O que mudou está abaixo, e os dados já são os vigentes.`,
      ],
      destaque: { rotulo: "Data atual do evento", valor: quando(r.dataEvento, r.horaEvento) },
      lista: [
        {
          titulo: "Alterações",
          itens: (r.alteracoes.length ? r.alteracoes : [`Status atual: ${r.status}`]).map(esc),
        },
      ],
      extra: `<p style="margin:14px 0 0;font-size:14px;color:${TEXTO};font-family:${FONTE};">${esc(
        r.rotuloInicio,
      )}: <b>${esc(r.inicio)}</b> · ${esc(r.rotuloFim)}: <b>${esc(r.fim)}</b></p>`,
      botao: { href: link(ident.baseUrl), label: "Acessar meu portal" },
    },
    perso,
  );
}

/* ------------------------------------------------------------------ */
/* 4. Cancelamento de reserva                                          */
/* ------------------------------------------------------------------ */

export function emailCancelamentoReserva(ident: IdentidadeEmail, r: ReservaEmail, perso?: PersonalizacaoEmail): EmailMontado {
  return montar(
    ident,
    {
      assunto: `Reserva ${r.numero} cancelada`,
      titulo: `Sobre o cancelamento da reserva ${r.numero}`,
      paragrafos: [
        `A reserva <b>${esc(r.numero)}</b> com a <b>${esc(ident.nome)}</b> foi cancelada${
          r.motivo ? ` pelo seguinte motivo: <b>${esc(r.motivo)}</b>` : ""
        }.`,
        `Ela estava marcada para <b>${quando(r.dataEvento, r.horaEvento)}</b>.`,
        `Se o cancelamento não partiu de você, ou se quiser remarcar, fale com a gente pelos contatos abaixo.`,
      ],
      botao: { href: link(ident.baseUrl), label: "Falar com a locadora" },
    },
    perso,
  );
}

/* ------------------------------------------------------------------ */
/* 5. Lembrete de operação (entrega / retirada)                        */
/* ------------------------------------------------------------------ */

export function emailLembreteOperacao(
  ident: IdentidadeEmail,
  o: OperacaoEmail,
  antecedencia: string,
  perso?: PersonalizacaoEmail,
): EmailMontado {
  const tipo = o.tipo.toLowerCase();
  const distancia = vazio(antecedencia) ? ` (${esc(antecedencia)})` : "";
  return montar(
    ident,
    {
      assunto: `${o.tipo} da reserva ${o.numero} — ${o.quando}`,
      titulo: `${o.tipo} agendada, ${o.cliente}`,
      paragrafos: [
        `A <b>${esc(ident.nome)}</b> agendou a <b>${esc(tipo)}</b> da sua locação para <b>${esc(
          o.quando,
        )}</b>${distancia}.`,
        o.endereco
          ? `O endereço é <b>${esc(o.endereco)}</b>.`
          : `Se o endereço mudou, avise a gente com antecedência para ajustarmos a rota.`,
      ],
      destaque: { rotulo: o.tipo, valor: esc(o.quando) },
      botao: { href: link(ident.baseUrl), label: "Acessar meu portal" },
    },
    perso,
  );
}

/* ------------------------------------------------------------------ */
/* 6. Saída para a operação                                            */
/* ------------------------------------------------------------------ */

export function emailSaidaOperacao(ident: IdentidadeEmail, o: OperacaoEmail, perso?: PersonalizacaoEmail): EmailMontado {
  const tipo = o.tipo.toLowerCase();
  // "Previsão de chegada" só faz sentido quando a equipe vai ao endereço.
  const previsao = /entreg|montag/i.test(o.tipo) ? "Previsão de chegada" : "Horário previsto";
  return montar(
    ident,
    {
      assunto: `Estamos a caminho — ${tipo} da reserva ${o.numero}`,
      titulo: `A equipe está a caminho, ${o.cliente}`,
      paragrafos: [
        `A equipe da <b>${esc(ident.nome)}</b> saiu para a <b>${esc(tipo)}</b> da reserva <b>${esc(o.numero)}</b>.`,
        `${previsao}: <b>${esc(o.quando)}</b>.`,
      ],
      extra: o.obs
        ? `<p style="margin:12px 0 0;font-size:13px;color:${TEXTO};font-family:${FONTE};">Observação: ${esc(o.obs)}</p>`
        : "",
      botao: { href: link(ident.baseUrl), label: "Acessar meu portal" },
    },
    perso,
  );
}

/* ------------------------------------------------------------------ */
/* 7. Operação concluída                                               */
/* ------------------------------------------------------------------ */

export function emailOperacaoConcluida(ident: IdentidadeEmail, o: OperacaoEmail, perso?: PersonalizacaoEmail): EmailMontado {
  const tipo = o.tipo.toLowerCase();
  return montar(
    ident,
    {
      assunto: `${o.tipo} concluída — reserva ${o.numero}`,
      titulo: `${o.tipo} concluída, ${o.cliente}`,
      paragrafos: [
        `Registramos a conclusão da <b>${esc(tipo)}</b> da reserva <b>${esc(o.numero)}</b>.`,
        `Data do registro: <b>${esc(o.quando)}</b>.`,
        `Se notou alguma divergência nos itens, fale com a gente — resolvemos juntos.`,
      ],
      botao: { href: link(ident.baseUrl), label: "Falar com a locadora" },
    },
    perso,
  );
}

/* ------------------------------------------------------------------ */
/* 8. Alteração de horário da operação                                 */
/* ------------------------------------------------------------------ */

export function emailAlteracaoOperacao(ident: IdentidadeEmail, o: OperacaoEmail, perso?: PersonalizacaoEmail): EmailMontado {
  const tipo = o.tipo.toLowerCase();
  const cancelada = o.status === "Cancelada";
  return montar(
    ident,
    {
      assunto: `${o.tipo} da reserva ${o.numero} ${cancelada ? "cancelada" : "reagendada"}`,
      titulo: cancelada ? `Sua ${tipo} foi cancelada, ${o.cliente}` : `Sua ${tipo} foi reagendada, ${o.cliente}`,
      paragrafos: [
        cancelada
          ? `A <b>${esc(tipo)}</b> da reserva <b>${esc(o.numero)}</b> foi <b>cancelada</b>. Se precisar remarcar, fale com a gente.`
          : `A <b>${esc(tipo)}</b> da reserva <b>${esc(o.numero)}</b> foi <b>reagendada</b>. O novo horário está abaixo.`,
      ],
      destaque: { rotulo: cancelada ? "Situação" : "Novo horário", valor: esc(cancelada ? "Cancelada" : o.quando) },
      extra: o.obs
        ? `<p style="margin:12px 0 0;font-size:13px;color:${TEXTO};font-family:${FONTE};">Observação: ${esc(o.obs)}</p>`
        : "",
      botao: { href: link(ident.baseUrl), label: "Falar com a locadora" },
    },
    perso,
  );
}

/* ------------------------------------------------------------------ */
/* 9. Operação em atraso                                               */
/* ------------------------------------------------------------------ */

export function emailOperacaoAtrasada(ident: IdentidadeEmail, o: OperacaoEmail, perso?: PersonalizacaoEmail): EmailMontado {
  const tipo = o.tipo.toLowerCase();
  return montar(
    ident,
    {
      assunto: `Sobre a ${tipo} da reserva ${o.numero}`,
      titulo: `Um retorno sobre a sua ${tipo}, ${o.cliente}`,
      paragrafos: [
        `A <b>${esc(tipo)}</b> da reserva <b>${esc(o.numero)}</b> estava prevista para <b>${esc(
          o.quando,
        )}</b> e ainda não foi registrada como concluída.`,
        `Estamos ajustando o agendamento e retornamos em breve. Se preferir falar agora, nossos contatos estão abaixo.`,
      ],
      botao: { href: link(ident.baseUrl), label: "Falar com a locadora" },
    },
    perso,
  );
}

/* ------------------------------------------------------------------ */
/* 10. Avanço no programa de fidelidade                                */
/* ------------------------------------------------------------------ */

export function emailFidelidadeProgresso(ident: IdentidadeEmail, f: FidelidadeEmail, perso?: PersonalizacaoEmail): EmailMontado {
  const restam = Math.max(0, f.faltam);
  return montar(
    ident,
    {
      assunto: `Seu programa de fidelidade avançou — ${ident.nome}`,
      titulo: `Você avançou no programa, ${f.cliente}`,
      paragrafos: [
        `Seu saldo na <b>${esc(ident.nome)}</b> agora é de <b>${f.atual} ${unidadeFidelidade(
          f.atual,
          f,
        )}</b> de ${f.meta}.`,
        restam > 0
          ? `Faltam <b>${restam} ${unidadeFidelidade(restam, f)}</b> para conquistar a recompensa.`
          : `Você atingiu a meta — sua recompensa já está disponível.`,
      ],
      destaque: {
        rotulo: "Seu progresso",
        valor: `${f.atual} de ${f.meta} ${unidadeFidelidade(f.meta, f)}`,
      },
      botao: { href: link(ident.baseUrl), label: "Acessar meu portal" },
    },
    perso,
  );
}

/* ------------------------------------------------------------------ */
/* 11. Proximidade da recompensa                                       */
/* ------------------------------------------------------------------ */

export function emailFidelidadeQuaseLa(ident: IdentidadeEmail, f: FidelidadeEmail, perso?: PersonalizacaoEmail): EmailMontado {
  return montar(
    ident,
    {
      assunto: `Faltam ${f.faltam} ${unidadeFidelidade(f.faltam, f)} para sua recompensa`,
      titulo: `Quase lá, ${f.cliente}`,
      paragrafos: [
        `Faltam <b>${f.faltam} ${unidadeFidelidade(f.faltam, f)}</b> para você completar a meta do programa da <b>${esc(
          ident.nome,
        )}</b>.`,
        `Seu saldo atual é de <b>${f.atual} de ${f.meta}</b>.`,
      ],
      destaque: { rotulo: "Falta", valor: `${f.faltam} ${unidadeFidelidade(f.faltam, f)}` },
      botao: { href: link(ident.baseUrl), label: "Acessar meu portal" },
    },
    perso,
  );
}

/* ------------------------------------------------------------------ */
/* 12. Benefício conquistado                                           */
/* ------------------------------------------------------------------ */

export function emailFidelidadeConquista(ident: IdentidadeEmail, f: FidelidadeEmail, perso?: PersonalizacaoEmail): EmailMontado {
  return montar(
    ident,
    {
      assunto: `Você conquistou uma recompensa — ${ident.nome}`,
      titulo: `Parabéns, ${f.cliente}!`,
      paragrafos: [
        `Você completou a meta do programa da <b>${esc(ident.nome)}</b> e ganhou: <b>${esc(f.beneficio)}</b>.`,
        f.condicoes.length
          ? `Condições combinadas pela locadora: ${f.condicoes.map((c) => `<b>${esc(c)}</b>`).join(" · ")}.`
          : `Para usar, é só falar com a gente na próxima locação.`,
      ],
      destaque: { rotulo: "Benefício conquistado", valor: esc(f.beneficio) },
      botao: { href: link(ident.baseUrl), label: "Falar com a locadora" },
    },
    perso,
  );
}

/* ------------------------------------------------------------------ */
/* 13. Recompensa utilizada                                            */
/* ------------------------------------------------------------------ */

export function emailFidelidadeUso(ident: IdentidadeEmail, f: FidelidadeEmail, perso?: PersonalizacaoEmail): EmailMontado {
  return montar(
    ident,
    {
      assunto: `Recompensa utilizada — ${ident.nome}`,
      titulo: `Recompensa registrada, ${f.cliente}`,
      paragrafos: [
        `Registramos o uso da recompensa <b>${esc(f.beneficio)}</b>${f.quando ? `, em <b>${esc(f.quando)}</b>` : ""}.`,
        `Seu programa continua valendo para as próximas locações.`,
      ],
      botao: { href: link(ident.baseUrl), label: "Acessar meu portal" },
    },
    perso,
  );
}

/* ------------------------------------------------------------------ */
/* 14. Recompensa prestes a vencer                                     */
/* ------------------------------------------------------------------ */

export function emailFidelidadeVencendo(ident: IdentidadeEmail, f: FidelidadeEmail, perso?: PersonalizacaoEmail): EmailMontado {
  return montar(
    ident,
    {
      assunto: `Sua recompensa vence em ${f.quando}`,
      titulo: `Atenção ao prazo da sua recompensa, ${f.cliente}`,
      paragrafos: [
        `A recompensa <b>${esc(f.beneficio)}</b> conquistada na <b>${esc(ident.nome)}</b> vence em <b>${esc(
          f.quando,
        )}</b>.`,
        `Fale com a gente antes do prazo para aproveitar.`,
      ],
      botao: { href: link(ident.baseUrl), label: "Falar com a locadora" },
    },
    perso,
  );
}

/* ------------------------------------------------------------------ */
/* 15. E-mail de teste                                                 */
/* ------------------------------------------------------------------ */

/**
 * Teste enviado pela tela de configurações: usa APENAS dados fictícios
 * ("Cliente Exemplo", reserva "TESTE-0000") — nenhum cliente real é lido e
 * nenhum registro fictício é criado no banco. O modelo personalizado da empresa
 * pode ser aplicado para o administrador ver exatamente o que o cliente verá.
 */
export function emailTeste(ident: IdentidadeEmail, destino: string, perso?: PersonalizacaoEmail): EmailMontado {
  return montar(
    ident,
    {
      assunto: `Teste de e-mail — ${ident.nome}`,
      titulo: `Sua configuração de e-mails está funcionando`,
      paragrafos: [
        `Este é um e-mail de teste da configuração de notificações da <b>${esc(ident.nome)}</b>.`,
        `Destinatário informado: <b>${esc(destino)}</b>.`,
        `Nenhum cliente real foi consultado e nenhuma reserva foi criada para este envio.`,
        `Se o visual, o remetente e os contatos do rodapé estiverem corretos, os avisos automáticos já podem ser ativados.`,
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
    },
    perso,
  );
}

/** Exportado para testes da camada de layout. */
export const __layout = { montar, cabecalho, rodape, botaoHtml };
