/**
 * Regra do programa de fidelidade (funcoes puras).
 *
 * Regra inicial: 5 locacoes elegiveis dao ate 5 kits gratis.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  aEmitir,
  beneficio,
  chaveEvento,
  dentroDaJanela,
  diasAte,
  elegivel,
  expiraEm,
  lembretesDeVencimento,
  progresso,
  recompensasDevidas,
  MODELOS_LEGADO,
  MODELOS_PADRAO,
  VARIAVEIS_FIDELIDADE,
  modeloFidelidade,
  normalizarUnidade,
  quantidadeUnidade,
  renderMensagemModelo,
  resolverUnidade,
  resumoProgresso,
  rotuloUnidade,
  situacao,
  utilizavel,
  REGRA_PADRAO,
  type EventoFidelidade,
  type Locacao,
  type Regra,
} from "../src/lib/fidelidade.ts";

const regra = (extra: Partial<Regra> = {}): Regra => ({ ...REGRA_PADRAO, ...extra });

describe("progresso do ciclo", () => {
  it("caminha de 1/5 ate 5/5", () => {
    const r = regra();
    assert.deepEqual(
      [1, 2, 3, 4].map((n) => progresso(n, r).noCiclo),
      [1, 2, 3, 4],
    );
    assert.equal(progresso(4, r).faltam, 1);
    assert.equal(progresso(5, r).faltam, 0, "meta fechada");
    assert.equal(progresso(5, r).ciclosCompletos, 1);
  });

  it("comeca um novo ciclo depois da meta", () => {
    const p = progresso(6, regra());
    assert.equal(p.noCiclo, 1, "6 locacoes = 1/5 do segundo ciclo");
    assert.equal(p.ciclosCompletos, 1);
    assert.equal(p.faltam, 4);
  });

  it("cliente sem locacao nao aparece devendo nada", () => {
    const p = progresso(0, regra());
    assert.equal(p.noCiclo, 0);
    assert.equal(p.faltam, 5);
    assert.equal(p.ciclosCompletos, 0);
  });

  it("a meta vem da configuracao, nao do codigo", () => {
    assert.equal(progresso(3, regra({ meta: 3 })).ciclosCompletos, 1);
    assert.equal(progresso(9, regra({ meta: 10 })).faltam, 1);
  });

  it("meta invalida nao quebra a conta", () => {
    assert.equal(progresso(5, regra({ meta: 0 })).meta, 1);
  });
});

describe("quais locacoes contam", () => {
  const loc = (extra: Partial<Locacao> = {}): Locacao => ({
    id: 1,
    status: "finalizada",
    total_cents: 50000,
    usou_recompensa: false,
    ...extra,
  });

  it("locacao finalizada conta", () => {
    assert.ok(elegivel(loc(), regra()));
  });

  it("orcamento, pre-reserva e cancelada nao contam", () => {
    for (const status of ["orcamento", "pre_reserva", "confirmada", "cancelada"]) {
      assert.ok(!elegivel(loc({ status }), regra()), status);
    }
  });

  it("locacao paga com recompensa nao gera ponto por padrao", () => {
    assert.ok(!elegivel(loc({ usou_recompensa: true }), regra()));
  });

  it("mas isso e configuravel", () => {
    assert.ok(elegivel(loc({ usou_recompensa: true }), regra({ contarLocacaoGratuita: true })));
  });

  it("valor minimo barra locacao pequena", () => {
    const r = regra({ valorMinimoCents: 30000 });
    assert.ok(!elegivel(loc({ total_cents: 20000 }), r));
    assert.ok(elegivel(loc({ total_cents: 30000 }), r), "o proprio minimo conta");
  });

  it("status elegiveis vem da configuracao", () => {
    assert.ok(elegivel(loc({ status: "confirmada" }), regra({ statusElegiveis: ["confirmada"] })));
  });
});

describe("emissao de recompensa", () => {
  it("cinco pontos geram uma recompensa", () => {
    assert.equal(recompensasDevidas(5, regra()), 1);
    assert.equal(recompensasDevidas(4, regra()), 0);
  });

  it("com acumulo, 10 e 15 pontos geram 2 e 3", () => {
    assert.equal(recompensasDevidas(10, regra()), 2);
    assert.equal(recompensasDevidas(15, regra()), 3);
  });

  it("sem acumulo, para em uma", () => {
    const r = regra({ acumular: false });
    assert.equal(recompensasDevidas(15, r), 1);
  });

  it("processar a mesma locacao duas vezes nao gera recompensa a mais", () => {
    // a conta parte do saldo, nao do evento: 5 pontos com 1 recompensa ja
    // emitida nao emite nada
    assert.equal(aEmitir(5, 1, regra()), 0);
    assert.equal(aEmitir(5, 0, regra()), 1);
    assert.equal(aEmitir(10, 1, regra()), 1);
  });

  it("reverter pontos nao apaga recompensa ja emitida", () => {
    assert.equal(aEmitir(4, 1, regra()), 0, "nao emite mais, mas tambem nao fica negativo");
  });
});

describe("validade", () => {
  it("sem validade configurada a recompensa nao expira", () => {
    assert.equal(expiraEm("2026-09-06", 0), null);
  });

  it("a validade e calculada na conquista", () => {
    assert.equal(expiraEm("2026-09-06", 30), "2026-10-06");
    assert.equal(expiraEm("2026-12-20", 15), "2027-01-04", "vira o ano");
  });

  it("recompensa vencida ontem ja aparece expirada hoje", () => {
    const r = { status: "disponivel" as const, expires_on: "2026-09-05" };
    assert.equal(situacao(r, "2026-09-06"), "expirada");
    assert.equal(utilizavel(r, "2026-09-06"), false);
  });

  it("no ultimo dia ainda da para usar", () => {
    const r = { status: "disponivel" as const, expires_on: "2026-09-06" };
    assert.equal(situacao(r, "2026-09-06"), "disponivel");
  });

  it("recompensa usada continua usada, nao vira expirada", () => {
    assert.equal(situacao({ status: "usada", expires_on: "2020-01-01" }, "2026-09-06"), "usada");
  });

  it("conta os dias que faltam", () => {
    assert.equal(diasAte("2026-09-13", "2026-09-06"), 7);
    assert.equal(diasAte(null, "2026-09-06"), null);
  });
});

describe("beneficio: ate N kits gratis", () => {
  const kit = (product_id: number, qty: number, preco: number) => ({
    product_id,
    qty,
    unit_price_cents: preco,
    kind: "kit",
  });
  const avulso = (product_id: number, qty: number, preco: number) => ({
    product_id,
    qty,
    unit_price_cents: preco,
    kind: "simples",
  });

  it("3 kits numa recompensa de 5: os 3 saem de graca", () => {
    const b = beneficio([kit(1, 3, 2000)], 5);
    assert.equal(b.kitsGratis, 3);
    assert.equal(b.descontoCents, 6000);
  });

  it("5 kits: todos gratuitos", () => {
    assert.equal(beneficio([kit(1, 5, 2000)], 5).descontoCents, 10000);
  });

  it("7 kits: so 5 sao cobertos, 2 continuam cobrados", () => {
    const b = beneficio([kit(1, 7, 2000)], 5);
    assert.equal(b.kitsGratis, 5);
    assert.equal(b.descontoCents, 10000, "R$ 100 de 7 x R$ 20 = R$ 140");
  });

  it("frete, forros e avulsos nunca entram no beneficio", () => {
    const b = beneficio([kit(1, 2, 2000), avulso(2, 50, 500), avulso(3, 10, 300)], 5);
    assert.equal(b.descontoCents, 4000, "so os 2 kits");
    assert.deepEqual(b.linhas.map((l) => l.product_id), [1]);
  });

  it("com varios kits, cobre primeiro os mais caros", () => {
    const b = beneficio([kit(1, 3, 1000), kit(2, 3, 3000)], 4);
    assert.equal(b.kitsGratis, 4);
    assert.equal(b.descontoCents, 3 * 3000 + 1 * 1000, "3 caros e 1 barato");
  });

  it("reserva sem kit nenhum nao gera desconto", () => {
    const b = beneficio([avulso(2, 100, 500)], 5);
    assert.equal(b.kitsGratis, 0);
    assert.equal(b.descontoCents, 0);
  });

  it("recompensa de zero kit nao desconta nada", () => {
    assert.equal(beneficio([kit(1, 5, 2000)], 0).descontoCents, 0);
  });
});

describe("evitar aviso repetido", () => {
  it("a chave muda por ciclo, entao o cliente e avisado de novo no proximo", () => {
    assert.notEqual(chaveEvento("quase_la", 7, 1), chaveEvento("quase_la", 7, 2));
    assert.equal(chaveEvento("quase_la", 7, 1), chaveEvento("quase_la", 7, 1), "mesma situacao, mesma chave");
  });

  it("clientes diferentes tem chaves diferentes", () => {
    assert.notEqual(chaveEvento("conquista", 7, 1), chaveEvento("conquista", 8, 1));
  });
});

describe("janela de envio", () => {
  it("nao manda de madrugada", () => {
    assert.equal(dentroDaJanela("2026-09-06T03:00", "08:00", "20:00"), false);
    assert.equal(dentroDaJanela("2026-09-06T21:30", "08:00", "20:00"), false);
  });

  it("manda dentro do horario, incluindo as bordas", () => {
    assert.ok(dentroDaJanela("2026-09-06T08:00", "08:00", "20:00"));
    assert.ok(dentroDaJanela("2026-09-06T20:00", "08:00", "20:00"));
    assert.ok(dentroDaJanela("2026-09-06T14:00", "08:00", "20:00"));
  });

  it("configuracao invalida nao trava o envio", () => {
    assert.ok(dentroDaJanela("2026-09-06T03:00", "", ""));
  });
});

describe("lembretes de vencimento", () => {
  it("le a lista configurada e ordena do mais distante", () => {
    assert.deepEqual(lembretesDeVencimento("7,3,1"), [7, 3, 1]);
    assert.deepEqual(lembretesDeVencimento("1 3 7"), [7, 3, 1]);
  });

  it("ignora lixo e repeticao", () => {
    assert.deepEqual(lembretesDeVencimento("7,7,abc,-2,9999,3"), [7, 3]);
  });

  it("lista vazia nao gera lembrete", () => {
    assert.deepEqual(lembretesDeVencimento(""), []);
  });
});

describe("frase do progresso", () => {
  it("fala no singular quando falta uma", () => {
    assert.match(resumoProgresso(progresso(4, regra()), 5), /falta 1 locação/);
  });

  it("fala no plural quando falta mais de uma", () => {
    assert.match(resumoProgresso(progresso(2, regra()), 5), /faltam 3 locações/);
  });

  it("anuncia a meta atingida", () => {
    assert.match(resumoProgresso(progresso(5, regra()), 5), /Meta atingida/);
  });
});

/* ------------------------------------------------------------------ */
/* Unidade da recompensa: o termo muda com o perfil operacional        */
/* ------------------------------------------------------------------ */

describe("unidade da recompensa por perfil", () => {
  it("festas continua falando kits", () => {
    assert.deepEqual(resolverUnidade("", "festas"), { singular: "kit", plural: "kits" });
    assert.equal(rotuloUnidade(resolverUnidade("", "festas")), "Kits grátis");
  });

  it("carretinhas fala locação/locações", () => {
    assert.deepEqual(resolverUnidade(undefined, "carretinhas"), { singular: "locação", plural: "locações" });
    assert.equal(rotuloUnidade(resolverUnidade("", "carretinhas")), "Locações grátis");
  });

  it("personalizado sem texto gravado cai no padrão da plataforma", () => {
    assert.deepEqual(resolverUnidade("   ", "personalizado"), { singular: "kit", plural: "kits" });
  });

  it("o que a empresa escreveu vence o perfil", () => {
    assert.deepEqual(resolverUnidade("vale", "carretinhas"), { singular: "vale", plural: "vales" });
    assert.deepEqual(resolverUnidade("diária/diárias", "festas"), { singular: "diária", plural: "diárias" });
  });

  it("plural derivado: brinde→brindes, locação→locações, kit→kits", () => {
    assert.equal(resolverUnidade("brinde", "festas").plural, "brindes");
    assert.equal(resolverUnidade("locação", "festas").plural, "locações");
    assert.equal(resolverUnidade("kit", "festas").plural, "kits");
  });

  it("normalizarUnidade limpa o campo e nunca grava lixo", () => {
    assert.equal(normalizarUnidade("  locação  "), "locação");
    assert.equal(normalizarUnidade("lo\u0000cação\n/  Diárias "), "locação/Diárias");
    assert.equal(normalizarUnidade("/  "), "", "só separador volta ao padrão");
    assert.equal(normalizarUnidade(null), "");
  });

  it("padrões por perfil ficam disponíveis para a tela de configuração", () => {
    assert.equal(REGRA_PADRAO.perfil, "festas");
    assert.deepEqual(REGRA_PADRAO.unidade, { singular: "kit", plural: "kits" });
  });
});

describe("textos com a unidade certa", () => {
  const locacao = { singular: "locação", plural: "locações" };

  it("quantidadeUnidade concorda singular e plural", () => {
    assert.equal(quantidadeUnidade(1, locacao), "1 locação");
    assert.equal(quantidadeUnidade(5, locacao), "5 locações");
    assert.equal(quantidadeUnidade(1), "1 kit");
    assert.equal(quantidadeUnidade(5), "5 kits");
  });

  it("frase do progresso usa a unidade da empresa", () => {
    assert.equal(
      resumoProgresso(progresso(2, regra()), 5, locacao),
      "2/5 · faltam 3 locações para até 5 locações grátis",
    );
    assert.equal(
      resumoProgresso(progresso(4, regra()), 1, locacao),
      "4/5 · falta 1 locação para até 1 locação grátis",
    );
  });

  it("sem unidade informada mantém o texto histórico de kits", () => {
    assert.equal(resumoProgresso(progresso(4, regra()), 5), "4/5 · falta 1 locação para até 5 kits grátis");
  });
});

describe("modelos de mensagem", () => {
  const eventos: EventoFidelidade[] = [
    "progresso",
    "quase_la",
    "conquista",
    "uso",
    "vencendo",
    "expirada",
    "reversao",
  ];

  it("padrão com {unidade}=kits é idêntico ao texto legado de Festas", () => {
    for (const e of eventos) {
      assert.equal(MODELOS_PADRAO[e].replace(/\{unidade\}/g, "kits"), MODELOS_LEGADO[e], e);
    }
  });

  it("{unidade} é variável aceita nas mensagens", () => {
    assert.ok(VARIAVEIS_FIDELIDADE.includes("unidade"));
  });

  it("mensagem nunca editada acompanha a unidade vigente", () => {
    assert.equal(modeloFidelidade("conquista", ""), MODELOS_PADRAO.conquista);
    assert.equal(modeloFidelidade("conquista", MODELOS_LEGADO.conquista), MODELOS_PADRAO.conquista);
  });

  it("texto que a empresa mudou de verdade prevalece", () => {
    const meu = "Fala com a gente, {cliente_nome}!";
    assert.equal(modeloFidelidade("conquista", meu), meu);
  });

  it("modelo é renderizado com as variáveis — nada de {chave} literal", () => {
    const texto = renderMensagemModelo(MODELOS_PADRAO.conquista, {
      cliente_nome: "Joao",
      locacoes_necessarias: 5,
      quantidade_kits: 5,
      unidade: "kits",
    });
    assert.equal(
      texto,
      "Parabéns, Joao! Você completou 5 locações e conquistou até 5 kits grátis. Fale com a gente para usar na sua próxima locação.",
    );
    assert.ok(!/\{\w+\}/.test(texto), `sobrou variável literal: ${texto}`);
  });

  it("unidade no singular quando a quantidade é 1", () => {
    const texto = renderMensagemModelo(MODELOS_PADRAO.expirada, {
      quantidade_kits: 1,
      unidade: "locação",
      data_expiracao: "20/10/2026",
    });
    assert.equal(texto, "Sua recompensa de até 1 locação grátis expirou em 20/10/2026.");
  });

  it("variável sem valor sai vazia e chave dupla continua funcionando", () => {
    assert.equal(renderMensagemModelo("Oi {cliente_nome}, tudo bem?", { cliente_nome: "" }), "Oi , tudo bem?");
    assert.equal(renderMensagemModelo("CNPJ {{empresa_doc}}", { empresa_doc: "123" }), "CNPJ 123");
  });
});

describe("benefício cobre produtos simples fora do perfil Festas", () => {
  const avulso = (product_id: number, qty: number, preco: number) => ({
    product_id,
    qty,
    unit_price_cents: preco,
    kind: "simples",
  });

  it("padrão continua descontando só kits", () => {
    assert.equal(beneficio([avulso(1, 5, 2000)], 5).descontoCents, 0);
  });

  it("com cobrirSimples a recompensa alcança itens simples", () => {
    const b = beneficio([avulso(1, 5, 2000)], 5, { cobrirSimples: true });
    assert.equal(b.kitsGratis, 5);
    assert.equal(b.descontoCents, 10000);
  });

  it("fora do limite da recompensa nada é de graça", () => {
    const b = beneficio([avulso(1, 10, 1000)], 3, { cobrirSimples: true });
    assert.equal(b.descontoCents, 3000);
    assert.equal(b.kitsGratis, 3);
  });

  it("kits continuam entrando com a flag ligada", () => {
    const kits = [{ product_id: 9, qty: 2, unit_price_cents: 4000, kind: "kit" }];
    assert.equal(beneficio(kits, 5, { cobrirSimples: true }).descontoCents, 8000);
  });
});
