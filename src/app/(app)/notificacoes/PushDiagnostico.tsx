"use client";
import { useEffect, useState } from "react";

type Servidor = {
  vapidConfigurado: boolean;
  pushLigado: boolean;
  ultimoCicloAgendador: number | null;
  ultimoEnvioComSucesso: number | null;
  ultimaFalha: string | null;
  naFila: number;
};
type Device = { id: number; label: string; enabled: number };

/**
 * Diagnostico do Push.
 *
 * "Permissao concedida" nao prova nada: o aviso so chega se o service worker
 * estiver ativo, a inscricao existir no aparelho E estar gravada no servidor, e
 * o servico do fabricante aceitar o envio. Cada elo aparece separado aqui, e o
 * botao de teste dispara um push real neste aparelho e mostra a resposta crua,
 * porque e ela que distingue credencial errada de queda de rede.
 */
export default function PushDiagnostico() {
  const [servidor, setServidor] = useState<Servidor | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [local, setLocal] = useState({
    https: false,
    instalado: false,
    swAtivo: false,
    permissao: "default" as NotificationPermission | "indisponivel",
    pushApi: false,
    inscricaoLocal: false,
  });
  const [teste, setTeste] = useState<string>("");
  const [ocupado, setOcupado] = useState(false);

  async function carregar() {
    const resposta = await fetch("/api/push", { cache: "no-store" });
    const dados = (await resposta.json()) as { diagnostico?: Servidor; devices?: Device[] };
    if (dados.diagnostico) setServidor(dados.diagnostico);
    setDevices(dados.devices ?? []);
  }

  useEffect(() => {
    void carregar().catch(() => {});
    (async () => {
      const temSW = "serviceWorker" in navigator;
      const registro = temSW ? await navigator.serviceWorker.getRegistration("/") : undefined;
      const inscricao = registro ? await registro.pushManager?.getSubscription().catch(() => null) : null;
      setLocal({
        https: location.protocol === "https:" || location.hostname === "localhost",
        instalado:
          window.matchMedia("(display-mode: standalone)").matches ||
          (window.navigator as unknown as { standalone?: boolean }).standalone === true,
        swAtivo: !!registro?.active,
        permissao: "Notification" in window ? Notification.permission : "indisponivel",
        pushApi: "PushManager" in window,
        inscricaoLocal: !!inscricao,
      });
    })().catch(() => {});
  }, []);

  const ativo = devices.find((d) => d.enabled);

  async function enviarTeste() {
    if (!ativo) return;
    setOcupado(true);
    setTeste("");
    try {
      const resposta = await fetch("/api/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "test", id: ativo.id }),
      });
      const dados = (await resposta.json()) as { ok?: boolean; status?: number; error?: string; detalhe?: string };
      setTeste(
        dados.ok
          ? `Aceito pelo serviço de push (HTTP ${dados.status}). Se o aviso não aparecer, o bloqueio está no próprio aparelho: modo foco, silencioso ou notificações do app desligadas no sistema.`
          : `Falhou: ${dados.error ?? "erro desconhecido"}${dados.detalhe ? ` - ${dados.detalhe}` : ""}`,
      );
      await carregar();
    } catch (e) {
      setTeste(e instanceof Error ? e.message : "Falha de conexão.");
    } finally {
      setOcupado(false);
    }
  }

  return (
    <section className="cartao space-y-3 p-4">
      <h2 className="font-bold">Diagnóstico do Push</h2>

      <div className="grid gap-1.5 sm:grid-cols-2">
        <Item ok={local.https} rotulo="Conexão segura (HTTPS)" />
        <Item ok={local.instalado} rotulo="Aberto como aplicativo instalado" dica="No iPhone o push só funciona pelo ícone da tela de início." />
        <Item ok={local.swAtivo} rotulo="Service worker ativo" />
        <Item ok={local.pushApi} rotulo="Push disponível neste navegador" />
        <Item
          ok={local.permissao === "granted"}
          rotulo={`Permissão: ${local.permissao}`}
          dica={local.permissao === "denied" ? "Libere nas configurações do site." : undefined}
        />
        <Item ok={local.inscricaoLocal} rotulo="Inscrição existe neste aparelho" />
        <Item ok={!!ativo} rotulo="Inscrição gravada no servidor" dica={!ativo ? "Ative o aparelho na seção acima." : undefined} />
        <Item ok={!!servidor?.vapidConfigurado} rotulo="Chaves VAPID no servidor" />
        <Item ok={!!servidor?.pushLigado} rotulo="Push habilitado no sistema" />
      </div>

      {servidor && (
        <dl className="space-y-0.5 rounded-xl bg-nuvem-100 p-3 text-xs text-stone-600">
          <Linha rotulo="Último ciclo do agendador" valor={quando(servidor.ultimoCicloAgendador)} />
          <Linha rotulo="Último envio aceito" valor={quando(servidor.ultimoEnvioComSucesso)} />
          <Linha rotulo="Na fila agora" valor={String(servidor.naFila)} />
          {servidor.ultimaFalha && <Linha rotulo="Última falha" valor={servidor.ultimaFalha} />}
        </dl>
      )}

      <button
        type="button"
        onClick={enviarTeste}
        disabled={ocupado || !ativo}
        className="rounded-xl bg-marca-600 px-4 py-2 font-semibold text-white disabled:opacity-50"
      >
        Enviar notificação de teste para este dispositivo
      </button>
      {!ativo && <p className="text-xs text-stone-500">Ative um dispositivo acima para poder testar.</p>}
      {teste && (
        <p role="status" className="rounded-xl bg-nuvem-100 p-3 text-sm">
          {teste}
        </p>
      )}
    </section>
  );
}

function Item({ ok, rotulo, dica }: { ok: boolean; rotulo: string; dica?: string }) {
  return (
    <div className="flex items-start gap-2 text-sm">
      <span className={`mt-0.5 shrink-0 font-bold ${ok ? "text-emerald-600" : "text-amber-600"}`}>{ok ? "OK" : "--"}</span>
      <span className="min-w-0">
        <span className={ok ? "text-stone-700" : "font-semibold text-tinta-900"}>{rotulo}</span>
        {dica && !ok && <span className="block text-xs text-stone-500">{dica}</span>}
      </span>
    </div>
  );
}

function Linha({ rotulo, valor }: { rotulo: string; valor: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt>{rotulo}</dt>
      <dd className="text-right font-medium text-tinta-900">{valor}</dd>
    </div>
  );
}

function quando(unix: number | null): string {
  if (!unix) return "nunca";
  return new Date(unix * 1000).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
}
