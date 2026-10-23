/**
 * Calculadora de frete (Menu + > Calcular Frete): decisões de UI e de
 * integração que a suíte funcional não enxerga, no mesmo padrão de
 * login-ui/nav-estrutura — leem a fonte dos componentes.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as planos from "../src/lib/planos";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ler = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const calculator = ler("src/app/(app)/fretes/calculadora/Calculator.tsx");
const pagina = ler("src/app/(app)/fretes/calculadora/page.tsx");
const mapa = ler("src/components/RouteMap.tsx");
const apiGeocode = ler("src/app/api/geocode/route.ts");
const apiOpcoes = ler("src/app/api/routes/opcoes/route.ts");

describe("campo de destino da calculadora", () => {
  it("existe na tela, com rótulo, placeholder e aria-label", () => {
    assert.match(calculator, /label="Endereço de destino"/, "campo de destino presente");
    assert.match(calculator, /aria-label="Endereço de destino"/);
    assert.match(calculator, /placeholder="Ex\.: Rua das Palmeiras/);
  });

  it("o campo é preenchido pela rota base → destino, sem nova fórmula", () => {
    assert.match(calculator, /\/api\/routes\/opcoes/, "consulta as opções de rota no servidor");
    assert.match(calculator, /onDistancia\(opcao\.totalKm\.toFixed\(2\)/, "distância da rota alimenta o campo de ida");
    assert.ok(!calculator.match(/distanciaTotalKm.*\* *[24VIAGENS]/), "não há multiplicação nova no cliente");
  });

  it("busca com debounce, cancela respostas fora de ordem e preserva o texto digitado", () => {
    assert.match(calculator, /setTimeout\(async/, "debounce antes de consultar");
    assert.match(calculator, /versao !== versaoSugestao\.current/, "respostas obsoletas descartadas");
    assert.match(calculator, /você pode digitar o endereço completo|Você pode digitar o endereço completo/, "falha não apaga o que o usuário digitou");
  });

  it("apresenta estados: buscando, sem resultado, erro e seleção", () => {
    assert.match(calculator, /Buscando endereços/);
    assert.match(calculator, /Nenhum endereço encontrado/);
    assert.match(calculator, /role="alert"/);
    assert.match(calculator, /Destino selecionado/);
  });

  it("cada opção oferece dados de identificação; ausente = não identificado", () => {
    assert.match(calculator, /não identificado/, "componente ausente é dito explicitamente");
    for (const rotulo of ["Logradouro", "Número", "Bairro", "CEP", "Cidade", "UF"]) {
      assert.ok(calculator.includes(`rotulo="${rotulo}"`), `exibe ${rotulo}`);
    }
    assert.match(calculator, /aproximado/, "resultado aproximado é sinalizado");
    assert.match(calculator, /Coordenadas:/, "coordenadas exibidas para confirmação");
  });

  it("mudar o destino invalida o resultado anterior (sem coordenadas velhas)", () => {
    assert.match(calculator, /valor\.trim\(\) !== destinoInfo\.label/, "edição do texto detecta mudança");
    assert.match(calculator, /onDistancia\(""\)/, "distância antiga é limpa");
    assert.match(calculator, /onDestinoInvalidado/, "destino anterior é invalidado");
  });

  it("rotas alternativas viram lista selecionável e o mapa fica sincronizado", () => {
    assert.match(calculator, /role="radiogroup" aria-label="Rotas encontradas"/);
    assert.match(calculator, /durationMin/, "duração exibida quando disponível");
    assert.match(calculator, /onSelect=\{selecionarNoMapa\}/, "clique no mapa seleciona a rota");
  });
});

describe("mapa da rota", () => {
  it("desenha a geometria retornada pelo provedor, com destaque da selecionada", () => {
    assert.match(mapa, /decodePolyline/, "polyline real do serviço de roteamento");
    assert.match(mapa, /fitBounds/, "enquadramento automático do percurso");
    assert.match(mapa, /COR_SELECIONADA/, "rota selecionada destacada");
    assert.match(mapa, /addListener\("click"/, "alternativa clicável no mapa");
    assert.match(mapa, /Marcador|Marker/, "marcadores de origem e destino");
  });
});

describe("integração e configuração", () => {
  it("a página injeta chave pública do mapa e o provedor do servidor", () => {
    assert.match(pagina, /GOOGLE_MAPS_CLIENT_KEY/, "lê a chave pública de mapa");
    assert.match(pagina, /providerEndereco\(env\.GOOGLE_MAPS_API_KEY\)/, "provedor decidido pela chave server-side");
    assert.ok(pagina.includes("try {") && pagina.includes("catch"), "dev sem bindings do Cloudflare não quebra a tela");
  });

  it("as APIs novas exigem sessão, limitam chamadas e protegem o módulo", () => {
    assert.match(apiGeocode, /apiUser\(request, true\)/);
    assert.match(apiGeocode, /rateLimit\(`geocode:\$\{user\.id\}`/);
    assert.match(apiOpcoes, /apiUser\(request, true\)/);
    assert.match(apiOpcoes, /rateLimit\(`maps:\$\{user\.id\}`/);
    assert.match(apiOpcoes, /maps:calculator:daily/, "teto diário próprio da calculadora");
    assert.match(apiOpcoes, /freightConfig\(await getSettings\(\)/, "configurações da EMPRESA autenticada (isolamento)");
    assert.match(apiOpcoes, /config\.baseAddress/, "origem vem do endereço-base configurado");
    assert.match(apiOpcoes, /GOOGLE_MAPS_API_KEY/, "chave privada só no servidor");
    assert.ok(!apiGeocode.includes("GOOGLE_MAPS_API_KEY:") || apiGeocode.includes("env.GOOGLE_MAPS_API_KEY"), "sem chave no corpo de resposta");
  });

  it("portão de plano: novas rotas seguem o módulo Fretes; /api/routes continua compartilhado", () => {
    assert.equal(planos.recursoDaApi("/api/geocode"), "fretes");
    assert.equal(planos.recursoDaApi("/api/routes/opcoes"), "fretes");
    assert.equal(planos.recursoDaApi("/api/routes"), null, "reservas/orçamentos seguem usando a base compartilhada");
  });
});
