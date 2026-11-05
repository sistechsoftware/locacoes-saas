/**
 * Identidade e personalização dos e-mails aos clientes.
 *
 * Cobre o que o pedido exige e o que não pode regredir:
 *  1. empresa COM logo → logo própria em URL pública absoluta;
 *  2. empresa SEM logo → imagem alternativa que o e-mail já usava (monograma);
 *  3. logo indisponível/não servível → fallback, nunca <img> quebrada;
 *  4. tenant correto em cada identidade;
 *  5. substituição de todas as variáveis do contexto;
 *  6. variáveis sem valor desaparecem (nada de undefined/null);
 *  7. variável inválida é detectada e não vira texto cru;
 *  8. assunto/título/corpo personalizados, mantendo os blocos de dados;
 *  9. restauração do modelo original;
 * 10. isolamento entre empresas (settings e envio);
 * 11. pré-visualização sem efeitos colaterais;
 * 12. teste não enfileira nem dispara evento real;
 * 13. o disparo automático existente continua funcionando e usa o modelo;
 * 14. HTML compatível com clientes de e-mail e responsivo.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createTestDb, resetTestDb } from "./helpers/d1.ts";
import { all, getDb, insert, resetCompanyCache, run, runWithCompany, scalar } from "../src/lib/db.ts";
import { setSettings, settingsDaEmpresa } from "../src/lib/settings.ts";
import { definirEnvDoAgendador, limparEnvDoAgendador } from "../src/lib/worker-env.ts";
import { monogramaEmpresa, urlLogoEmail } from "../src/lib/email-identidade.ts";
import { chaveModelo, lerModelo, lerModelos, serializarModelo, validarModelo } from "../src/lib/email-modelos.ts";
import type { ModeloEmail } from "../src/lib/email-modelos.ts";
import {
  VARIAVEIS_EMAIL,
  aplicarVariaveis,
  chavesDoTipo,
  chavesInvalidas,
  variaveisDeReserva,
} from "../src/lib/email-variaveis.ts";
import {
  dadosDaReserva,
  identidadeDaEmpresa,
  operacaoConfigDaEmpresa,
} from "../src/lib/email-dados.ts";
import { renderizarPreviaModelo } from "../src/lib/email-preview.ts";
import { emailConfirmacaoReserva, emailTeste, __layout } from "../src/lib/email-templates.ts";
import type { IdentidadeEmail } from "../src/lib/email-templates.ts";
import { amostraReserva } from "../src/lib/email-amostra.ts";
import { agendarEmail } from "../src/lib/email-queue.ts";
import { runEmailScheduler } from "../src/lib/email-scheduler.ts";
import type { EmailMensagem, ResultadoEnvio } from "../src/lib/email.ts";

const BASE = "https://app.locogestao.test";
const HEX = "0123456789abcdef0123456789abcdef";
const HEX_B = "fedcba9876543210fedcba9876543210";

/** Identidade mínima para os testes de layout (sem banco). */
function identidade(over: Partial<IdentidadeEmail> = {}): IdentidadeEmail {
  return {
    nome: "Festas Lima",
    logo: null,
    telefone: "(11) 3333-4444",
    whatsapp: "",
    endereco: "Rua das Flores, 120",
    cidade: "São Paulo",
    email: "contato@festaslima.test",
    documento: "12.345.678/0001-90",
    tagline: "Locação de móveis para eventos",
    cor: "#051094",
    instrucoes: "",
    baseUrl: BASE,
    ...over,
  };
}

beforeEach(() => {
  createTestDb();
  resetCompanyCache();
  definirEnvDoAgendador({ PUBLIC_URL: BASE });
});
afterEach(() => {
  resetTestDb();
  resetCompanyCache();
  limparEnvDoAgendador();
});

/* ------------------------------------------------------------------ */
/* 1 a 4 — logo e identidade por tenant                                */
/* ------------------------------------------------------------------ */

describe("logo da empresa no cabeçalho", () => {
  it("logo cadastrada vira URL PÚBLICA e absoluta (a rota interna exige sessão)", () => {
    // O caminho gravado é o da tela logada — relativo e protegido.
    assert.equal(
      urlLogoEmail(`/api/arquivo/${HEX}`, BASE),
      `${BASE}/api/publico/arquivo/${HEX}`,
      "o e-mail precisa da rota pública, não da rota com sessão",
    );
    // Rota pública salva direto continua válida e não duplica o prefixo.
    assert.equal(urlLogoEmail(`/api/publico/arquivo/${HEX}`, BASE), `${BASE}/api/publico/arquivo/${HEX}`);
    // URL absoluta de terceiro é respeitada como está.
    assert.equal(urlLogoEmail("https://cdn.exemplo.com/logo.png", BASE), "https://cdn.exemplo.com/logo.png");
  });

  it("sem origem pública configurada não inventa host: cai no fallback", () => {
    assert.equal(urlLogoEmail(`/api/arquivo/${HEX}`, ""), null);
    assert.equal(urlLogoEmail("/imagens/logo.png", ""), null);
    // absoluta não depende da origem do ambiente
    assert.equal(urlLogoEmail("https://cdn.exemplo.com/logo.png", ""), "https://cdn.exemplo.com/logo.png");
  });

  it("logo indisponível ou inválida não vira <img> quebrada", () => {
    assert.equal(urlLogoEmail("", BASE), null);
    assert.equal(urlLogoEmail("data:image/png;base64,AAA", BASE), null);
    assert.equal(urlLogoEmail("javascript:alert(1)", BASE), null);
    assert.equal(urlLogoEmail("/api/arquivo/nao-e-hex", BASE), null);

    // Com logo não servível, o cabeçalho usa o monograma e NUNCA um <img>.
    const html = emailConfirmacaoReserva(identidade({ logo: null }), amostraReserva()).html;
    assert.equal(html.includes("<img"), false, "cabeçalho com imagem inválida");
    assert.ok(html.includes(monogramaEmpresa("Festas Lima")), "faltou o monograma de fallback");
  });

  it("empresa COM logo: imagem discreta, proporção preservada e nome sempre visível", () => {
    const logo = `${BASE}/api/publico/arquivo/${HEX}`;
    const html = emailConfirmacaoReserva(identidade({ logo }), amostraReserva()).html;
    assert.ok(html.includes(`src="${logo}"`), "logo própria ausente do cabeçalho");
    assert.ok(html.includes('alt="Festas Lima"'), "alt ausente: quem bloqueia imagem não identifica a empresa");
    // Só a altura é fixa; largura acompanha a proporção (sem distorção).
    assert.match(html, /height:40px/);
    assert.match(html, /width:auto/);
    assert.ok(!/width:40px/.test(html), "largura fixa distorceria a logo");
    // O nome ao lado garante a identificação mesmo sem carregar a imagem.
    assert.ok(html.includes("Festas Lima"));
  });

  it("cada empresa usa a PRÓPRIA identidade (nunca a logo de outra)", async () => {
    await run(`INSERT INTO companies (id, name, active) VALUES (2,'Zumbi Eventos',1)`);
    await setSettings(
      { company_name: "Festas Lima", company_logo: `/api/arquivo/${HEX}`, company_phone: "1133334444" },
      1,
    );
    await setSettings(
      { company_name: "Zumbi Eventos", company_logo: `/api/arquivo/${HEX_B}`, company_phone: "1155556666" },
      2,
    );

    const a = await identidadeDaEmpresa(1);
    const b = await identidadeDaEmpresa(2);

    assert.equal(a.nome, "Festas Lima");
    assert.equal(b.nome, "Zumbi Eventos");
    assert.equal(a.logo, `${BASE}/api/publico/arquivo/${HEX}`);
    assert.equal(b.logo, `${BASE}/api/publico/arquivo/${HEX_B}`);
    assert.ok(!b.logo!.includes(HEX), "a empresa 2 herdou a logo da 1");

    // E o HTML de cada uma só cita a sua própria logo.
    const htmlB = emailConfirmacaoReserva(b, amostraReserva()).html;
    assert.ok(htmlB.includes(HEX_B));
    assert.ok(!htmlB.includes(HEX), "logo de outro tenant vazou para o e-mail");
  });

  it("o e-mail default da empresa não inventa contato quando não cadastrado", async () => {
    // DEFAULT_SETTINGS usa um placeholder técnico; exibi-lo seria mentir no rodapé.
    const id = await identidadeDaEmpresa(1);
    assert.equal(id.email, "");
  });
});

/* ------------------------------------------------------------------ */
/* 5 a 7 — variáveis                                                   */
/* ------------------------------------------------------------------ */

describe("variáveis dinâmicas", () => {
  const vars = variaveisDeReserva(identidade(), amostraReserva());

  it("substitui TODAS as variáveis do contexto da reserva", () => {
    const permitidas = chavesDoTipo("reserva_confirmacao");
    assert.ok(permitidas.includes("reserva_valor_total"));
    // orçamento não é oferecido: o sistema não envia e-mail de orçamento.
    assert.equal(permitidas.some((c) => c.startsWith("orcamento_")), false);

    const texto = permitidas.map((c) => `{{${c}}}`).join(" | ");
    const out = aplicarVariaveis(texto, vars);
    assert.ok(!out.includes("{{"), `sobrou variável sem substituir: ${out}`);
    assert.ok(out.includes("TESTE-0000"));
    assert.ok(out.includes("Cliente"));
  });

  it("variável sem valor DESAPARECE — nada de undefined, null ou chaves", () => {
    const vazias = { ...vars, cliente_telefone: "", empresa_whatsapp: "", reserva_endereco_entrega: "" };
    const out = aplicarVariaveis("Tel: {{cliente_telefone}}Whats: {{empresa_whatsapp}}Local: {{reserva_endereco_entrega}}.",
      vazias,
    );
    assert.equal(out, "Tel: Whats: Local: .");
    assert.ok(!/undefined|null|\{\{/.test(out), out);
  });

  it("variável inválida é detectada e não entra crua no HTML", () => {
    const invalidas = chavesInvalidas("Olá {{cliente_nome}} {{nao_existe}}", chavesDoTipo("reserva_confirmacao"));
    assert.deepEqual(invalidas, ["nao_existe"]);

    const out = aplicarVariaveis("A{{nao_existe}}B", vars);
    assert.equal(out, "AB");
  });

  it("valor do cadastro entra ESCAPADO (sem injeção de HTML)", () => {
    const out = aplicarVariaveis("{{cliente_nome}}", { cliente_nome: '<script>alert("x")</script>' });
    assert.equal(out, "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    assert.ok(!out.includes("<script>"));
  });

  it("lista de itens vira conteúdo organizado, não texto solto", () => {
    const html = aplicarVariaveis("{{reserva_itens}}", vars);
    assert.ok(html.includes("Mesa"), html);
    assert.ok(html.includes("Cadeira"));
    assert.ok(html.includes("<br/>"), "itens deveriam ser uma lista de linhas");
    assert.ok(html.includes("× 10"));
    // sem itens, a variável desaparece
    const semItens = variaveisDeReserva(identidade(), { ...amostraReserva(), itens: [] });
    assert.equal(aplicarVariaveis("Itens: {{reserva_itens}}", semItens), "Itens: ");
  });

  it("catálogo e contextos são coerentes", () => {
    assert.ok(VARIAVEIS_EMAIL.length >= 25);
    for (const v of VARIAVEIS_EMAIL) {
      assert.match(v.chave, /^[a-z0-9_]+$/);
      assert.ok(v.rotulo && v.descricao && v.exemplo, `${v.chave} sem documentação`);
      assert.ok(v.contextos.length > 0);
    }
    // operação não oferece variável de reserva que ela não carrega
    assert.equal(chavesDoTipo("operacao_lembrete").includes("reserva_valor_total"), false);
    assert.ok(chavesDoTipo("operacao_lembrete").includes("operacao_tipo"));
    assert.ok(chavesDoTipo("fidelidade_conquista").includes("fidelidade_beneficio"));
  });
});

/* ------------------------------------------------------------------ */
/* 8, 9 e 10 — personalização, restauração e isolamento                */
/* ------------------------------------------------------------------ */

describe("modelos personalizados", () => {
  const modelo: ModeloEmail = {
    assunto: "Olá, {{cliente_nome}}: reserva {{reserva_codigo}}",
    titulo: "Tudo certo para {{reserva_data_evento}}",
    corpo: "Sua locação com a {{empresa_nome}} está confirmada para {{reserva_data_evento}}.",
    assinatura: "Equipe {{empresa_nome}}",
  };

  it("assunto, título e corpo são personalizados e os dados continuam vindo do sistema", () => {
    const vars = variaveisDeReserva(identidade(), amostraReserva());
    const email = emailConfirmacaoReserva(identidade(), amostraReserva(), { modelo, vars });

    assert.equal(email.assunto, "Olá, Cliente: reserva TESTE-0000");
    assert.ok(email.html.includes("Tudo certo para 01/01/2099"));
    assert.ok(email.html.includes("Sua locação com a Festas Lima está confirmada"));
    assert.ok(email.html.includes("Equipe Festas Lima"));
    // o bloco de dados (data em destaque + itens) não some com a personalização
    assert.ok(email.html.includes("Data do evento"));
    assert.ok(email.html.includes("Mesa"));
    assert.ok(!email.html.includes("{{"));
    // o assunto antigo não sobrou
    assert.ok(!email.html.includes("Reserva TESTE-0000 confirmada"));
  });

  it("modelo vazio = texto original revisado (personalização é opcional)", () => {
    const padrao = emailConfirmacaoReserva(identidade(), amostraReserva()).assunto;
    assert.ok(padrao.includes("confirmada"));
    assert.equal(lerModelo({}, "reserva_confirmacao"), null);
  });

  it("restauração volta ao original", async () => {
    await setSettings({ [chaveModelo("reserva_confirmacao")]: serializarModelo(modelo) }, 1);
    assert.ok(lerModelo(await settingsDaEmpresa(1), "reserva_confirmacao")?.assunto);

    // restaurar = gravar vazio (é o que o botão faz)
    await setSettings({ [chaveModelo("reserva_confirmacao")]: serializarModelo({}) }, 1);
    assert.equal(lerModelo(await settingsDaEmpresa(1), "reserva_confirmacao"), null);
    assert.equal(serializarModelo({}), "");
  });

  it("isolamento: personalizar a empresa 1 não altera a 2", async () => {
    await run(`INSERT INTO companies (id, name, active) VALUES (2,'Zumbi Eventos',1)`);
    await setSettings({ [chaveModelo("reserva_confirmacao")]: serializarModelo(modelo) }, 1);

    const a = lerModelo(await settingsDaEmpresa(1), "reserva_confirmacao");
    const b = lerModelo(await settingsDaEmpresa(2), "reserva_confirmacao");
    assert.ok(a?.assunto);
    assert.equal(b, null, "o modelo da empresa 1 vazou para a 2");

    const todosA = lerModelos(await settingsDaEmpresa(1));
    const todosB = lerModelos(await settingsDaEmpresa(2));
    assert.ok(todosA.reserva_confirmacao.assunto);
    assert.deepEqual(todosB.reserva_confirmacao, {});
  });

  it("limites de tamanho são validados (configuração quebrada não entra)", () => {
    assert.equal(validarModelo({ assunto: "ok" }), null);
    assert.ok(validarModelo({ assunto: "x".repeat(161) }), "assunto acima do limite passou");
    // JSON inválido não vira modelo nem quebra o envio
    assert.equal(lerModelo({ [chaveModelo("reserva_confirmacao")]: "{nao é json" }, "reserva_confirmacao"), null);
  });
});

/* ------------------------------------------------------------------ */
/* 11 e 12 — prévia e teste                                            */
/* ------------------------------------------------------------------ */

describe("pré-visualização e teste", () => {
  it("a prévia monta o e-mail completo sem gravar nada na fila", async () => {
    await setSettings({ company_name: "Festas Lima", company_phone: "1133334444" }, 1);
    const ident = await identidadeDaEmpresa(1);
    const antes = await scalar<number>(`SELECT COUNT(*) FROM email_notifications`);
    const m = await renderizarPreviaModelo({
      companyId: 1,
      tipo: "reserva_confirmacao",
      modelo: { corpo: "Olá {{cliente_nome}}, sua reserva é {{reserva_codigo}}." },
    });

    assert.ok(m.html.includes("<!doctype html>"));
    assert.ok(m.html.includes("Olá Cliente, sua reserva é TESTE-0000."));
    assert.ok(m.html.includes("Festas Lima"), "rodapé sem o nome da empresa");
    assert.ok(ident.telefone.length > 0, "telefone cadastrado não chegou à identidade");
    assert.ok(m.html.includes(ident.telefone), "rodapé sem contato cadastrado");
    assert.ok(m.assunto.length > 0);
    assert.ok(m.texto.includes("Olá Cliente"), "alternativa em texto puro ausente");

    const depois = await scalar<number>(`SELECT COUNT(*) FROM email_notifications`);
    assert.equal(depois, antes, "a prévia enfileirou e-mail");
  });

  it("a prévia respeita o tenant: reserva de outra empresa cai na amostra", async () => {
    await run(`INSERT INTO companies (id, name, active) VALUES (2,'Zumbi Eventos',1)`);
    const cliente = await insert(`INSERT INTO customers (name, email, company_id) VALUES ('Ana','ana@x.com',2)`);
    const reserva = await insert(
      `INSERT INTO reservations (number, customer_id, status, event_date, company_id)
       VALUES ('R-2',?,'confirmada','2099-03-01',2)`,
      [cliente],
    );

    const m = await renderizarPreviaModelo({ companyId: 1, tipo: "reserva_confirmacao", reservaId: reserva });
    assert.ok(!m.html.includes("R-2"), "prévia da empresa 1 mostrou reserva da 2");
    assert.ok(m.html.includes("TESTE-0000"));
  });

  it("o envio de teste tem dados fictícios e NÃO passa pela fila", async () => {
    const m = emailTeste(identidade(), "dono@empresa.test");
    assert.ok(m.html.includes("Cliente Exemplo"));
    assert.ok(m.html.includes("TESTE-0000"));
    assert.equal(m.html.includes("{{"), false);

    // O teste é a única leitura síncrona do provedor: não pode enfileirar.
    const src = fs.readFileSync(
      path.join(process.cwd(), "src/app/(app)/configuracoes/email-modelos-actions.ts"),
      "utf8",
    );
    assert.ok(src.includes("enviarEmailDetalhado"));
    assert.ok(!/agendarEmail\s*\(/.test(src), "o teste não pode agendar notificação real");
    assert.ok(src.includes('"email_teste"'), "o histórico do teste precisa nascer como email_teste");
    assert.ok(src.includes("assertAdmin()"), "sem guarda de administrador");
  });
});

/* ------------------------------------------------------------------ */
/* 13 — disparos automáticos com o modelo                              */
/* ------------------------------------------------------------------ */

describe("disparo automático continua funcionando e usa o modelo", () => {
  it("o cron envia o texto personalizado da empresa dona da reserva", async () => {
    await run(`INSERT INTO companies (id, name, active) VALUES (2,'Zumbi Eventos',1)`);
    await setSettings(
      {
        company_name: "Zumbi Eventos",
        email_enabled: "1",
        email_hora_envio: "00:00",
        company_logo: `/api/arquivo/${HEX}`,
      },
      2,
    );
    await setSettings(
      {
        [chaveModelo("reserva_confirmacao")]: serializarModelo({
          assunto: "Olá, {{cliente_nome}}",
          corpo: "Reserva {{reserva_codigo}} confirmada. Total {{reserva_valor_total}}.",
        }),
      },
      2,
    );

    const cliente = await insert(`INSERT INTO customers (name, email, company_id) VALUES ('Carla Dias','carla@x.com',2)`);
    const reserva = await insert(
      `INSERT INTO reservations (number, customer_id, status, event_date, event_time, company_id, total_cents)
       VALUES ('ZUMBI-1',?,'confirmada','2099-02-10','10:00',2,125000)`,
      [cliente],
    );

    await agendarEmail({
      companyId: 2,
      type: "reserva_confirmacao",
      source: "reserva",
      sourceId: reserva,
      reservationId: reserva,
      customerId: cliente,
      context: { reservation_id: reserva },
      dedupeKey: `c2:reserva_confirmacao:${reserva}:confirmada`,
    });

    const chamadas: EmailMensagem[] = [];
    const enviado: ResultadoEnvio = { ok: true, id: "id-1", status: 200, temporaria: false, erro: null, motivoConfig: null };
    const now = Math.floor(Date.now() / 1000);
    const saida = await runWithCompany(2, () =>
      runEmailScheduler(getDb(), now, async (msg) => {
        chamadas.push(msg);
        return enviado;
      }),
    );

    assert.equal(saida.enviados, 1, "o disparo automático deixou de enviar");
    assert.equal(chamadas.length, 1);
    assert.equal(chamadas[0].to, "carla@x.com");
    assert.ok(chamadas[0].subject.includes("Olá, Carla"), chamadas[0].subject);
    assert.ok(chamadas[0].html.includes("Reserva ZUMBI-1 confirmada"));
    assert.match(chamadas[0].html, /R\$\s*1\.250,00/u, "variável de valor não foi preenchida");
    assert.ok(chamadas[0].html.includes(`${BASE}/api/publico/arquivo/${HEX}`), "logo do tenant ausente");
    assert.equal(chamadas[0].html.includes("{{"), false);
    assert.equal(chamadas[0].deNome, "Zumbi Eventos");

    const linha = await all<{ status: string; subject: string }>(
      `SELECT status, subject FROM email_notifications WHERE company_id = 2`,
    );
    assert.equal(linha[0].status, "enviado");
    assert.equal(linha[0].subject, chamadas[0].subject);
  });
});

/* ------------------------------------------------------------------ */
/* 14 — HTML compatível e responsivo                                   */
/* ------------------------------------------------------------------ */

describe("HTML do e-mail", () => {
  const html = emailConfirmacaoReserva(identidade({ logo: `${BASE}/api/publico/arquivo/${HEX}` }), amostraReserva())
    .html;

  it("usa tabelas e CSS inline, sem recursos que clientes de e-mail não suportam", () => {
    assert.ok(html.includes('role="presentation"'));
    assert.ok(html.includes('width="100%"'));
    assert.ok(html.includes("max-width:560px"));
    assert.equal(/display\s*:\s*flex/i.test(html), false, "flexbox não é confiável em e-mail");
    assert.equal(/display\s*:\s*grid/i.test(html), false, "grid não é confiável em e-mail");
    assert.equal(/position\s*:\s*absolute/i.test(html), false);
    assert.equal(html.includes("<script"), false);
    assert.equal(/<link[^>]+stylesheet/i.test(html), false, "sem folha externa");
    assert.equal(html.includes("javascript:"), false);
  });

  it("tem cabeçalho, corpo e rodapé identificáveis e leitura em celular", () => {
    assert.ok(html.includes('lang="pt-BR"'));
    assert.ok(html.includes('name="viewport"'));
    assert.ok(html.includes("@media only screen and (max-width:480px)"));
    assert.ok(html.includes("class=\"email-cabecalho\""));
    assert.ok(html.includes("class=\"email-corpo\""));
    assert.ok(html.includes("class=\"email-rodape\""));
    // rodapé com identidade da empresa (mesma informação do PDF de reserva)
    assert.ok(html.includes("CNPJ/CPF: 12.345.678/0001-90"));
    assert.ok(html.includes("Rua das Flores, 120 · São Paulo"));
    assert.ok(html.includes("cliente da Festas Lima"));
  });

  it("acentuação e caracteres especiais são preservados", () => {
    const m = emailConfirmacaoReserva(identidade({ nome: "Locações & Festas" }), {
      ...amostraReserva(),
      cliente: "José",
      endereco: "Rua São João, 120 — Ação",
    });
    assert.ok(m.html.includes("José"));
    assert.ok(m.html.includes("Locações &amp; Festas"));
    assert.ok(m.html.includes("São João, 120 — Ação"));
    assert.equal(m.html.includes("undefined"), false);
    assert.equal(m.html.includes("null"), false);
  });

  it("o layout não expõe helper interno de forma descontrolada", () => {
    assert.equal(typeof __layout.montar, "function");
    assert.equal(typeof __layout.rodape, "function");
  });
});

/* ------------------------------------------------------------------ */
/* Compatibilidade do fluxo antigo                                     */
/* ------------------------------------------------------------------ */

describe("origem pública por ambiente", () => {
  it("staging não aponta PUBLIC_URL para o domínio de produção", () => {
    // A logo e os links dos e-mails saem com PUBLIC_URL. Se staging apontar para
    // o domínio de produção, a URL da logo cai no D1 do outro ambiente e o
    // cliente de e-mail mostra imagem quebrada (o caso que originou este teste).
    const cfg = fs.readFileSync(path.join(process.cwd(), "wrangler.jsonc"), "utf8");
    const inicio = cfg.indexOf('"name": "limas-saas-staging"');
    assert.ok(inicio > 0, "bloco de staging não encontrado no wrangler.jsonc");
    const bloco = cfg.slice(inicio, cfg.indexOf('"triggers"', inicio));
    const m = /"PUBLIC_URL":\s*"([^"]*)"/.exec(bloco);
    assert.ok(m, "staging sem PUBLIC_URL declarado");
    assert.match(m![1], /limas-saas-staging/, `staging PUBLIC_URL deveria ser a origem do próprio Worker, veio ${m![1]}`);
    assert.equal(/locogestao\.com\.br/.test(m![1]), false, "staging apontando para o domínio de produção");
  });
});

describe("compatibilidade com o fluxo existente", () => {
  it("os templates continuam aceitando a chamada antiga, sem personalização", async () => {
    // Assinaturas antigas (ident, dados) seguem válidas: o terceiro parâmetro é opcional.
    const email = emailConfirmacaoReserva(identidade(), amostraReserva());
    assert.equal(typeof email.assunto, "string");
    assert.equal(typeof email.html, "string");
    assert.equal(typeof email.texto, "string");

    // e os dados de reserva continuam sendo os mesmos campos de sempre
    const cfg = await operacaoConfigDaEmpresa(1);
    const r = await dadosDaReserva(1, 0, cfg);
    assert.equal(r.ok, false, "reserva inexistente deveria ser recusada");
  });
});
