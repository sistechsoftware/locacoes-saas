"use client";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alerta, Card, Field, Grid, Row } from "@/components/ui";
import { Icon } from "@/components/Icons";
import RouteMap, { type RotaMapa } from "@/components/RouteMap";
import { money, parseMoney } from "@/lib/format";
import { calcularFrete, VIAGENS, type TipoFrete } from "@/lib/freight";

export type ConfigFrete = {
  /** Endereço-base da empresa para ESTE tipo de frete (origem das rotas). */
  baseAddress: string;
  fuelType: string;
  fuelPriceCents: number;
  consumption: number;
  costPerKmCents: number;
  marginPercent: number;
  minimumCents: number;
  roundingCents: number;
  laborCents: number;
};

export type ComponentesEndereco = {
  logradouro: string | null;
  numero: string | null;
  bairro: string | null;
  cep: string | null;
  cidade: string | null;
  uf: string | null;
};

type Sugestao = {
  mainText: string;
  secondaryText: string;
  label: string;
  components: ComponentesEndereco;
  lat: number | null;
  lon: number | null;
  aproximado: boolean;
};

type OpcaoRota = RotaMapa & { durationMin: number | null };
type DestinoInfo = { label: string; components: ComponentesEndereco; lat: number; lon: number; aproximado: boolean };
type OrigemInfo = { label: string; lat: number; lon: number };

/**
 * Calculo roda inteiro no navegador, a partir das configuracoes ja carregadas.
 * A distância pode vir da rota base → destino (campo de endereço com
 * autocomplete, opções de trajeto e mapa) ou ser digitada manualmente — em
 * ambos os casos a fórmula comercial existente é a mesma, multiplicando a
 * ida pelas viagens do tipo de frete.
 */
export default function Calculator({
  configs,
  salvarPreco,
  mapKey = null,
  provider = "osm",
}: {
  configs: Record<TipoFrete, ConfigFrete>;
  salvarPreco: (fd: FormData) => Promise<void>;
  /** Chave pública do Google Maps para o mapa (null = mapa desabilitado). */
  mapKey?: string | null;
  provider?: "google" | "osm";
}) {
  const [tipo, setTipo] = useState<TipoFrete>("locacao");
  const config = configs[tipo];
  function selectType(value: TipoFrete) {
    setTipo(value);
    setPrecoLitro((configs[value].fuelPriceCents/100).toFixed(2));
    setMaoDeObra((configs[value].laborCents/100).toFixed(2));
  }
  const [distancia, setDistancia] = useState("");
  const [destino, setDestino] = useState<string | null>(null);
  const [precoLitro, setPrecoLitro] = useState((config.fuelPriceCents / 100).toFixed(2));
  const [editandoPreco, setEditandoPreco] = useState(false);
  const [pedagio, setPedagio] = useState("0,00");
  const [maoDeObra, setMaoDeObra] = useState((config.laborCents / 100).toFixed(2));
  const [mostrarAvancado, setMostrarAvancado] = useState(false);

  const km = Number(String(distancia).replace(",", ".")) || 0;

  const resultado = useMemo(
    () =>
      calcularFrete({
        distanciaIdaKm: km,
        tipo,
        consumoKmPorLitro: config.consumption,
        precoLitroCents: parseMoney(precoLitro),
        custoPorKmCents: config.costPerKmCents,
        pedagioCents: parseMoney(pedagio),
        maoDeObraCents: parseMoney(maoDeObra),
        margemPercent: config.marginPercent,
        valorMinimoCents: config.minimumCents,
        arredondamentoCents: config.roundingCents,
      }),
    [km, tipo, precoLitro, pedagio, maoDeObra, config],
  );

  const limpar = () => {
    setDistancia("");
    setDestino(null);
    setPedagio("0,00");
    setMaoDeObra((config.laborCents / 100).toFixed(2));
    setPrecoLitro((config.fuelPriceCents / 100).toFixed(2));
    setEditandoPreco(false);
  };

  const temResultado = km > 0;
  const precoAlterado = parseMoney(precoLitro) !== config.fuelPriceCents;

  return (
    <div className="space-y-4">
      <Card>
        <Field label="Tipo de frete">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <TipoOpcao
              checked={tipo === "comum"}
              onSelect={() => selectType("comum")}
              titulo="Frete comum"
              descricao="Uma entrega: ida e volta."
              viagens={VIAGENS.comum}
            />
            <TipoOpcao
              checked={tipo === "locacao"}
              onSelect={() => selectType("locacao")}
              titulo="Frete de Locação"
              descricao="Entrega e, depois, retirada."
              viagens={VIAGENS.locacao}
            />
          </div>
        </Field>

        <div className="mt-3">
          <EnderecoDestino
            tipo={tipo}
            basePresente={config.baseAddress.trim().length > 0}
            mapKey={mapKey}
            provider={provider}
            onDistancia={setDistancia}
            onDestino={setDestino}
            onDestinoInvalidado={() => { setDistancia(""); setDestino(null); }}
          />
        </div>

        <div className="mt-3">
          <Field label="Distância de ida (km) *" hint="Somente a ida. As viagens de volta entram no cálculo. Preenchida pela rota ou digitada à mão.">
            <input
              value={distancia}
              onChange={(e) => setDistancia(e.target.value)}
              inputMode="decimal"
              placeholder="15"
              className="campo text-lg"
              aria-label="Distância de ida em quilômetros"
            />
          </Field>
        </div>

        {temResultado && (
          <p className="mt-2 rounded-xl bg-marca-50 px-3 py-2 text-sm font-semibold text-marca-700">
            {formatarKm(km)} km x {resultado.viagens} viagens = {formatarKm(resultado.distanciaTotalKm)} km totais
          </p>
        )}

        <div className="mt-3 rounded-xl border border-nuvem-300 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm text-tinta-700">
              Combustível ({config.fuelType}):{" "}
              <b className="text-tinta-900">{money(parseMoney(precoLitro))}/L</b>
              <span className="ml-1 text-xs text-stone-500">- {config.consumption} km/L</span>
            </span>
            <button
              type="button"
              onClick={() => setEditandoPreco((v) => !v)}
              className="text-xs font-semibold text-marca-600 underline underline-offset-2"
            >
              {editandoPreco ? "Fechar" : "Alterar"}
            </button>
          </div>

          {editandoPreco && (
            <div className="mt-2 space-y-2">
              <input
                value={precoLitro}
                onChange={(e) => setPrecoLitro(e.target.value)}
                inputMode="decimal"
                className="campo"
                aria-label="Preço do litro"
              />
              <p className="text-xs text-stone-500">
                Vale somente para este cálculo. Para alterar permanentemente, use o botão abaixo.
              </p>
              {precoAlterado && (
                <form action={salvarPreco}>
                  <input type="hidden" name="tipo" value={tipo} />
                  <input type="hidden" name="preco" value={precoLitro} />
                  <button className="rounded-xl border border-marca-600 bg-white px-3 py-2 text-xs font-semibold text-marca-600">
                    Salvar {money(parseMoney(precoLitro))}/L como padrão
                  </button>
                </form>
              )}
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={() => setMostrarAvancado((v) => !v)}
          className="mt-3 text-xs font-semibold text-marca-600"
        >
          {mostrarAvancado ? "Ocultar" : "Pedágio e mão de obra"}
        </button>

        {mostrarAvancado && (
          <Grid>
            <Field label="Pedágio (R$)">
              <input value={pedagio} onChange={(e) => setPedagio(e.target.value)} inputMode="decimal" className="campo" />
            </Field>
            <Field label="Mão de obra (R$)">
              <input
                value={maoDeObra}
                onChange={(e) => setMaoDeObra(e.target.value)}
                inputMode="decimal"
                className="campo"
              />
            </Field>
          </Grid>
        )}

        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={limpar}
            className="rounded-xl border border-nuvem-300 bg-white px-4 py-2.5 text-sm font-semibold text-tinta-900"
          >
            Limpar
          </button>
          <Link
            href="/configuracoes?aba=frete"
            className="rounded-xl border border-nuvem-300 bg-white px-4 py-2.5 text-sm font-semibold text-tinta-900"
          >
            Configuracoes
          </Link>
        </div>
      </Card>

      {!temResultado ? (
        <Alerta tone="azul">Informe o destino (ou a distância de ida) para ver o valor sugerido.</Alerta>
      ) : (
        <>
          <div className="rounded-2xl bg-destaque-500 p-5 text-center text-tinta-900 shadow-sm">
            <p className="text-xs font-bold uppercase tracking-wide opacity-80">Valor Sugerido do Frete</p>
            <p className="mt-1 text-4xl font-black">{money(resultado.valorSugeridoCents)}</p>
            {resultado.aplicouMinimo && (
              <p className="mt-1 text-xs font-semibold">
                Valor mínimo de {money(resultado.valorMinimoCents)} aplicado.
              </p>
            )}
          </div>

          <section className="cartao overflow-hidden">
            <header className="border-b border-nuvem-200 bg-nuvem-50 px-4 py-3">
              <h2 className="text-sm font-bold uppercase tracking-wide text-tinta-700">Resumo do Frete</h2>
            </header>
            <div className="p-4">
              <Row label="Tipo" value={tipo === "locacao" ? "Frete de Locação" : "Frete Comum"} />
              {destino && <Row label="Destino" value={destino} />}
              <Row label="Distância de ida" value={`${formatarKm(km)} km`} />
              <Row label="Quantidade de viagens" value={resultado.viagens} />
              <Row label="Distância total" value={`${formatarKm(resultado.distanciaTotalKm)} km`} />
              <Row label="Consumo" value={`${config.consumption} km/L`} />
              <Row label="Combustível utilizado" value={`${resultado.litros.toFixed(2)} L`} />
              <Row label="Custo de combustível" value={money(resultado.custoCombustivelCents)} />
              <Row label="Custo operacional" value={money(resultado.custoOperacionalCents)} />
              {resultado.pedagioCents > 0 && <Row label="Pedágios" value={money(resultado.pedagioCents)} />}
              {resultado.maoDeObraCents > 0 && <Row label="Mão de obra" value={money(resultado.maoDeObraCents)} />}
              <Row
                label="Custo total da operação"
                value={<b className="text-tinta-900">{money(resultado.custoTotalCents)}</b>}
              />
              <Row label="Margem de lucro" value={`${resultado.margemPercent}%`} />
              <Row label="Preço calculado" value={money(resultado.precoCalculadoCents)} />
              <Row
                label="Valor sugerido"
                value={<b className="text-marca-600">{money(resultado.valorSugeridoCents)}</b>}
              />
              <Row
                label="Lucro estimado"
                value={<span className="text-emerald-600">{money(resultado.lucroEstimadoCents)}</span>}
              />
            </div>
          </section>

          <Card>
            <p className="mb-2 text-sm font-semibold text-tinta-900">Usar este valor</p>
            <div className="flex flex-wrap gap-2">
              <Link
                href={`/fretes/novo?valor=${(resultado.valorSugeridoCents / 100).toFixed(2)}`}
                className="inline-flex items-center gap-2 rounded-xl bg-marca-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-marca-700"
              >
                <Icon name="fretes" className="h-4 w-4" />                  Novo Frete com este Valor
              </Link>
              <Link
                href={`/reservas/nova?frete=${(resultado.valorSugeridoCents / 100).toFixed(2)}`}
                className="inline-flex items-center gap-2 rounded-xl border border-marca-600 bg-white px-4 py-2.5 text-sm font-semibold text-marca-600"
              >
                <Icon name="reservas" className="h-4 w-4" />                  Usar numa Reserva
              </Link>
            </div>
            <p className="mt-2 text-xs text-stone-500">
              Combustível, custo operacional e margem são informações internas e não aparecem para o cliente.
            </p>
          </Card>
        </>
      )}
    </div>
  );
}

function TipoOpcao({
  checked,
  onSelect,
  titulo,
  descricao,
  viagens,
}: {
  checked: boolean;
  onSelect: () => void;
  titulo: string;
  descricao: string;
  viagens: number;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`rounded-xl border p-3 text-left transition ${
        checked ? "border-marca-600 bg-marca-50" : "border-nuvem-300 bg-white hover:bg-nuvem-50"
      }`}
    >
      <span className="flex items-center gap-2">
        <span
          className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2 ${
            checked ? "border-marca-600" : "border-stone-300"
          }`}
        >
          {checked && <span className="h-2 w-2 rounded-full bg-marca-600" />}
        </span>
        <span className="text-sm font-bold text-tinta-900">{titulo}</span>
      </span>
      <span className="mt-1 block text-xs leading-snug text-stone-500">
        {descricao} <b className="text-tinta-700">{viagens} viagens</b>
      </span>
    </button>
  );
}

/**
 * Campo de destino: autocomplete de endereços brasileiros (logradouro, bairro,
 * CEP, cidade e UF para confirmar o destino certo), cálculo das rotas de IDA
 * (base → destino) e mapa com o traçado real. A distância da rota escolhida
 * alimenta o campo "Distância de ida (km)"; quem multiplica pelas viagens é a
 * fórmula comercial de sempre. Mudar o destino invalida o resultado anterior.
 */
function EnderecoDestino({
  tipo,
  basePresente,
  mapKey,
  provider,
  onDistancia,
  onDestino,
  onDestinoInvalidado,
}: {
  tipo: TipoFrete;
  basePresente: boolean;
  mapKey: string | null;
  provider: "google" | "osm";
  onDistancia: (km: string) => void;
  onDestino: (label: string | null) => void;
  onDestinoInvalidado: () => void;
}) {
  const [texto, setTexto] = useState("");
  const [sugestoes, setSugestoes] = useState<Sugestao[]>([]);
  const [sugestoesAbertas, setSugestoesAbertas] = useState(false);
  const [buscando, setBuscando] = useState(false);
  const [erroBusca, setErroBusca] = useState("");
  const [opcoes, setOpcoes] = useState<OpcaoRota[]>([]);
  const [selecionada, setSelecionada] = useState<number | null>(null);
  const [origem, setOrigem] = useState<OrigemInfo | null>(null);
  const [destinoInfo, setDestinoInfo] = useState<DestinoInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [erro, setErro] = useState("");
  const versaoSugestao = useRef(0);
  const versaoRota = useRef(0);
  const raiz = useRef<HTMLDivElement | null>(null);

  const limparResultado = useCallback(() => {
    setOpcoes([]);
    setSelecionada(null);
    setOrigem(null);
    setDestinoInfo(null);
    onDestino(null);
  }, [onDestino]);

  // Sugestões com debounce; respostas fora de ordem são descartadas pela
  // geração e o texto digitado NUNCA é apagado por falha de serviço.
  useEffect(() => {
    const consulta = texto.trim();
    if (consulta.length < 4) {
      setSugestoes([]);
      setErroBusca("");
      setBuscando(false);
      return;
    }
    const versao = ++versaoSugestao.current;
    setBuscando(true);
    const timer = setTimeout(async () => {
      try {
        const response = await fetch("/api/geocode", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: consulta }),
        });
        const data = await response.json() as { suggestions?: unknown; error?: string };
        if (versao !== versaoSugestao.current) return;
        if (!response.ok) {
          setSugestoes([]);
          setErroBusca(typeof data?.error === "string" ? data.error : "Não foi possível buscar endereços agora.");
          return;
        }
        setErroBusca("");
        setSugestoes(
          Array.isArray(data?.suggestions)
            ? (data.suggestions as Sugestao[]).filter(s => s && typeof s?.label === "string" && s?.label.trim())
            : [],
        );
      } catch {
        if (versao === versaoSugestao.current) {
          setSugestoes([]);
          setErroBusca("Falha de conexão ao buscar endereços. Você pode digitar o endereço completo.");
        }
      } finally {
        if (versao === versaoSugestao.current) setBuscando(false);
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [texto]);

  // Trocou o tipo de frete: a origem pode ser outra (base por tipo) — refaz a rota.
  const destinoAtual = destinoInfo?.label ?? "";
  useEffect(() => {
    if (destinoAtual) consultarRotas(destinoAtual);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tipo]);

  // Fecha a lista de sugestões ao clicar fora (padrão iOS: toque fora fecha).
  useEffect(() => {
    function fora(event: PointerEvent) {
      if (!raiz.current?.contains(event.target as Node)) setSugestoesAbertas(false);
    }
    document.addEventListener("pointerdown", fora);
    return () => document.removeEventListener("pointerdown", fora);
  }, []);

  function alterarTexto(valor: string) {
    setTexto(valor);
    setSugestoesAbertas(true);
    if (destinoInfo && valor.trim() !== destinoInfo.label) {
      // Usuário está mudando o destino: o resultado anterior deixa de valer.
      limparResultado();
      onDistancia("");
      setErro("");
    }
  }

  function falhar(mensagem: string) {
    setOpcoes([]);
    setSelecionada(null);
    setOrigem(null);
    setDestinoInfo(null);
    setErro(mensagem);
    onDistancia("");
    onDestino(null);
  }

  async function consultarRotas(alvo: string) {
    const destinoTexto = alvo.trim();
    if (!basePresente) {
      falhar("Cadastre o endereço-base da empresa em Configurações › Frete antes de calcular.");
      return;
    }
    if (destinoTexto.length < 5) {
      falhar("Informe o destino com mais detalhe: rua, bairro e cidade — ou CEP.");
      return;
    }
    const versao = ++versaoRota.current;
    setBusy(true);
    setErro("");
    try {
      const response = await fetch("/api/routes/opcoes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tipo, destination: destinoTexto }),
      });
      const data = await response.json() as {
        error?: string;
        origem?: OrigemInfo;
        destino?: DestinoInfo;
        opcoes?: OpcaoRota[];
      };
      if (versao !== versaoRota.current) return;
      if (!response.ok) {
        falhar(typeof data?.error === "string" ? data.error : "Não foi possível consultar a rota. Informe a distância manualmente.");
        return;
      }
      const validas = Array.isArray(data?.opcoes)
        ? data.opcoes.filter(o => o && Number.isFinite(o.totalKm) && o.totalKm > 0)
        : [];
      if (!validas.length || !data?.destino || !Number.isFinite(data.destino.lat)) {
        falhar("Nenhuma rota rodoviária encontrada para este destino. Refine o endereço ou informe a distância manualmente.");
        return;
      }
      setOpcoes(validas);
      setOrigem(data.origem ?? null);
      setDestinoInfo(data.destino);
      escolher(validas[0], data.destino);
    } catch {
      if (versao === versaoRota.current) {
        falhar("Não foi possível consultar a rota agora. Informe a distância manualmente.");
      }
    } finally {
      if (versao === versaoRota.current) setBusy(false);
    }
  }

  function escolher(opcao: OpcaoRota, destinoEscolhido?: DestinoInfo) {
    setSelecionada(opcao.index);
    // Envia somente a ida; quem multiplica pelas viagens é a fórmula de sempre.
    onDistancia(opcao.totalKm.toFixed(2).replace(".", ","));
    const alvo = destinoEscolhido ?? destinoInfo;
    if (alvo) onDestino(alvo.label);
  }

  const selecionarNoMapa = useCallback((index: number) => {
    const opcao = opcoes.find(o => o.index === index);
    if (opcao) escolher(opcao);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opcoes, destinoInfo]);

  const rotasParaMapa = useMemo(
    () => opcoes.map(o => ({ index: o.index, geometry: o.geometry ?? "", totalKm: o.totalKm })),
    [opcoes],
  );

  return (
    <div>
      <div ref={raiz} className="relative">
        <Field
          label="Endereço de destino"
          hint="Rua, número, bairro e cidade — ou CEP. A origem é o endereço-base da empresa."
        >
          <input
            value={texto}
            onChange={(e) => alterarTexto(e.target.value)}
            onFocus={() => sugestoes.length > 0 && setSugestoesAbertas(true)}
            inputMode="text"
            autoComplete="off"
            placeholder="Ex.: Rua das Palmeiras, 120, Santa Mônica, Uberlândia - MG"
            className="campo"
            aria-label="Endereço de destino"
            aria-expanded={sugestoesAbertas}
          />
        </Field>
        {sugestoesAbertas && sugestoes.length > 0 && (
          <ul className="absolute z-20 left-0 right-0 top-full mt-1 overflow-hidden rounded-xl border border-nuvem-300 bg-white shadow-lg">
            {sugestoes.map((s, i) => (
              <li key={`${s.label}-${i}`}>
                <button
                  type="button"
                  className="w-full px-3 py-3 text-left text-sm text-tinta-900 hover:bg-marca-50"
                  onClick={() => {
                    setTexto(s.label);
                    setSugestoesAbertas(false);
                    consultarRotas(s.label);
                  }}
                >
                  <span className="flex items-start justify-between gap-2">
                    <span className="font-semibold">{s.mainText || s.label}</span>
                    {s.aproximado && (
                      <span className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800">
                        aproximado
                      </span>
                    )}
                  </span>
                  {s.secondaryText && <span className="mt-0.5 block text-xs text-stone-500">{s.secondaryText}</span>}
                </button>
              </li>
            ))}
            <li className="border-t border-nuvem-200 px-3 py-1.5 text-[11px] text-stone-400">
              {provider === "google" ? "Sugestões por Google Maps" : <>© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer" className="underline">OpenStreetMap contributors</a></>}
            </li>
          </ul>
        )}
        {sugestoesAbertas && !buscando && !erroBusca && texto.trim().length >= 4 && sugestoes.length === 0 && (
          <p className="mt-1 text-xs text-stone-500">
            Nenhum endereço encontrado. Tente rua + bairro + cidade, ou pesquise pelo CEP.
          </p>
        )}
      </div>

      {buscando && (
        <p aria-live="polite" className="mt-1 text-xs font-semibold text-marca-700">Buscando endereços…</p>
      )}
      {erroBusca && (
        <p role="alert" className="mt-1 text-xs text-amber-700">{erroBusca}</p>
      )}

      {!basePresente && (
        <p className="mt-1 text-xs text-amber-700">
          Cadastre o endereço base da empresa em Configurações para calcular o frete por endereço.
        </p>
      )}

      <button
        type="button"
        disabled={busy}
        onClick={() => consultarRotas(texto)}
        className="mt-2 w-full rounded-xl bg-marca-600 px-4 py-3 text-sm font-semibold text-white transition active:scale-[0.98] disabled:opacity-50 sm:w-auto"
      >
        {busy ? "Calculando rota..." : "Consultar rota"}
      </button>

      {busy && (
        <p aria-live="polite" className="mt-2 text-sm font-semibold text-marca-700">
          Calculando rota...
        </p>
      )}
      {erro && (
        <p role="alert" className="mt-2 text-sm text-red-700">
          {erro}
        </p>
      )}

      {destinoInfo && (
        <div className="mt-3 rounded-xl border border-nuvem-300 bg-nuvem-50 p-3 text-sm" aria-live="polite">
          <p className="text-xs font-bold uppercase tracking-wide text-tinta-700">Destino selecionado</p>
          <p className="mt-1 font-semibold text-tinta-900">{destinoInfo.label}</p>
          <dl className="mt-1 grid grid-cols-1 gap-x-4 gap-y-0.5 text-xs text-stone-600 sm:grid-cols-2">
            <LinhaDado rotulo="Logradouro" valor={destinoInfo.components?.logradouro} />
            <LinhaDado rotulo="Número" valor={destinoInfo.components?.numero} />
            <LinhaDado rotulo="Bairro" valor={destinoInfo.components?.bairro} />
            <LinhaDado rotulo="CEP" valor={destinoInfo.components?.cep} />
            <LinhaDado rotulo="Cidade" valor={destinoInfo.components?.cidade} />
            <LinhaDado rotulo="UF" valor={destinoInfo.components?.uf} />
          </dl>
          <p className="mt-1 text-[11px] text-stone-400">
            Coordenadas: {formatarCoord(destinoInfo.lat)}, {formatarCoord(destinoInfo.lon)}
          </p>
          {destinoInfo.aproximado && (
            <p className="mt-1 text-xs font-semibold text-amber-700">
              Endereço aproximado — confirme se é o local correto antes de usar o valor.
            </p>
          )}
        </div>
      )}

      {opcoes.length > 1 && (
        <div className="mt-2 space-y-2" role="radiogroup" aria-label="Rotas encontradas">
          {opcoes.map((opcao) => (
            <button
              key={opcao.index}
              type="button"
              role="radio"
              aria-checked={selecionada === opcao.index}
              onClick={() => escolher(opcao)}
              className={`w-full rounded-xl border p-3 text-left transition ${
                selecionada === opcao.index ? "border-marca-600 bg-marca-50" : "border-nuvem-300 bg-white"
              }`}
            >
              <span className="flex items-center justify-between gap-2">
                <span className="text-sm font-bold text-tinta-900">Rota {opcao.index + 1}</span>
                <span className="text-sm font-semibold text-tinta-900">{formatarKm(opcao.totalKm)} km</span>
              </span>
              <span className="mt-0.5 block text-xs text-stone-500">
                {opcao.durationMin !== null ? `aproximadamente ${opcao.durationMin} min` : "duração indisponível"}
                {selecionada === opcao.index ? " · selecionada" : ""}
              </span>
            </button>
          ))}
        </div>
      )}

      {opcoes.length === 1 && selecionada === 0 && !busy && !erro && (
        <p className="mt-2 text-sm text-emerald-700">
          Rota única aplicada: {formatarKm(opcoes[0].totalKm)} km de ida.
        </p>
      )}

      {origem && destinoInfo && opcoes.length > 0 && mapKey && (
        <div className="mt-3">
          <RouteMap
            chave={mapKey}
            origem={origem}
            destino={{ label: destinoInfo.label, lat: destinoInfo.lat, lon: destinoInfo.lon }}
            rotas={rotasParaMapa}
            selecionada={selecionada ?? 0}
            onSelect={selecionarNoMapa}
          />
        </div>
      )}

      {opcoes.length > 0 && !mapKey && (
        <p className="mt-2 text-xs text-stone-500">
          Mapa indisponível nesta instância: o Google Maps não está configurado. A rota e a distância são as reais.
        </p>
      )}
    </div>
  );
}

function LinhaDado({ rotulo, valor }: { rotulo: string; valor: string | null | undefined }) {
  if (!valor) {
    return (
      <div>
        <dt className="inline font-semibold text-tinta-700">{rotulo}: </dt>
        <dd className="inline text-amber-700">não identificado</dd>
      </div>
    );
  }
  return (
    <div>
      <dt className="inline font-semibold text-tinta-700">{rotulo}: </dt>
      <dd className="inline">{valor}</dd>
    </div>
  );
}

const formatarKm = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1).replace(".", ","));
const formatarCoord = (n: number) => (Number.isFinite(n) ? n.toFixed(5).replace(".", ",") : "?");
