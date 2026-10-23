import { requireUser } from "@/lib/auth";
import { estadoAssinaturaSeguro } from "@/lib/assinatura-gate";
import { ajustesMenuDaEmpresa } from "@/lib/plano-personalizado";
import { redirect } from "next/navigation";
import PushRegistration from "@/components/PushRegistration";
import { scalar, emLoteLeituras } from "@/lib/db";
import { getSettings } from "@/lib/settings";
import { unreadCount } from "@/lib/notifications";
import { unreadCounters } from "@/lib/chat";
import { seedUnread } from "@/lib/chat-unread";
import { getOperacao } from "@/lib/operacao-db";
import { pluralizar, tituloOperacoes } from "@/lib/operacao";
import { resolverNavLayout, type NavLayout } from "@/lib/nav";
import { BottomNav, FloatingAction, Sidebar, TopBar } from "@/components/Shell";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  /*
   * Tudo que o layout lê (sessão, assinatura, ajustes do menu, settings,
   * contadores e configuração operacional) roda dentro de emLoteLeituras:
   * as leituras da mesma volta viram UM batch() do D1 em vez de uma ida por
   * consulta. Este layout envolve TODA a área autenticada, então o ganho vale
   * para todo clique do app — não só para a tela de reserva.
   */
  return await emLoteLeituras(async () => {
  // Este layout É quem trata o bloqueio (redireciona para a tela explicativa),
  // por isso é o único ponto que pede o gate "ignorar" — ver teste estático.
  const user = await requireUser({ bloqueio: "ignorar" });

  /*
   * Uma onda só para tudo que o layout lê depois da sessão: estado da
   * assinatura (memo da requisição — requireUser já leu), ajustes do menu,
   * settings, contadores e configuração operacional. Antes eram três esperas
   * encadeadas (gate → ajustes → grupo), e cada espera era uma volta ao D1
   * antes do primeiro byte de QUALQUER tela da área autenticada.
   */
  const [estado, ajustes, settings, unread, chat, operacao] = await Promise.all([
    /*
     * Gate comercial (Etapa 3): assinatura expirada/suspensa/cancelada bloqueia
     * TODA a area autenticada. Pendência #05: a leitura não é mais fail-open —
     * estadoAssinaturaSeguro devolve o último estado conhecido quando a consulta
     * falha e `null` (desconhecido) quando não há evidência recente; sem
     * confirmação de que a conta está boa, o gate não abre (as escritas são
     * barradas pelo mesmo helper no backend).
     */
    estadoAssinaturaSeguro(user.company_id),
    /*
     * Personalizações da empresa (painel /saas): liberações/bloqueios
     * administrativos e cortesia vigente ajustam o MENU (apresentação). A
     * porta de verdade segue no backend — requireModule/requireModuleEdit/
     * apiUser aplicam a MESMA precedência central.
     */
    user.platform_admin
      ? Promise.resolve(null)
      : ajustesMenuDaEmpresa(user.company_id).catch(() => null),
    // Os alertas sao recalculados no dashboard e na tela de notificacoes, e nao
    // aqui: rodar a varredura em toda navegacao deixava cada clique lento.
    getSettings(),
    scalar<number>("SELECT COUNT(*) FROM user_notifications WHERE user_id=? AND read_at IS NULL", [user.id]),
    unreadCounters(user.id),
    getOperacao(),
  ]);

  const bloqueado = estado === null || estado.bloqueioDuro === true;
  if (bloqueado && user.platform_admin === false) {
    return <AssinaturaBloqueada />;
  }

  /*
   * Recursos contratados (correção de planos): o slug vem da ASSINATURA da
   * empresa (banco), nunca do navegador, e só serve para filtrar o MENU
   * (itens pagos fora do plano não aparecem). A porta de verdade é o backend:
   * requireModule/requireModuleEdit/apiUser barram página, action e API.
   * platform_admin opera sem restrição de plano (mesma exceção do gate).
   */
  const planoSlug: string | null | undefined = user.platform_admin ? undefined : (estado?.plano?.slug ?? null);
  /*
   * Layout de navegacao escolhido (Configuracoes > Navegacao): "classico"
   * preserva o menu de sempre; "agrupado" organiza os mesmos destinos em
   * grupos. Valor fora da lista (ausente, vazio ou lixo) cai no classico —
   * empresas existentes continuam vendo exatamente o menu de hoje.
   */
  const navLayout: NavLayout = resolverNavLayout(settings.nav_layout);
  // Primeiro quadro: o contador ja nasce preenchido no servidor, sem piscar
  // de zero nem esperar a primeira consulta do ciclo compartilhado. A partir
  // daqui, apenas essa fonte alimenta topo, menu e tela do chat.
  seedUnread({
    unread: chat.unread,
    unreadConversations: chat.unreadConversations,
    conversations: [],
  });

  return (
    <div className="flex min-h-screen">
      <PushRegistration />
      <Sidebar
        company={settings.company_name}
        logo={settings.company_logo}
        operacaoLabel={tituloOperacoes(operacao)}
        planoSlug={planoSlug}
        ajustes={ajustes}
        platformAdmin={user.platform_admin}
        layout={navLayout}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar user={user} company={settings.company_name} logo={settings.company_logo} planoSlug={planoSlug} ajustes={ajustes} />
        <main className="com-barra-inferior mx-auto w-full max-w-6xl flex-1 p-3 sm:p-5">{children}</main>
      </div>
      <BottomNav operacaoLabel={tituloOperacoes(operacao)} planoSlug={planoSlug} ajustes={ajustes} layout={navLayout} />
      <FloatingAction
        novaOperacaoLabel={`Nova ${pluralizar(operacao.rotulos.operacao_inicio)}`}
        planoSlug={planoSlug}
        ajustes={ajustes}
        layout={navLayout}
      />
      {estado?.avisoVencimento && <AvisoVencimento dias={estado.diasRestantes} />}
    </div>
  );
  });
}

/**
 * Redireciona a area bloqueada para a tela explicativa (fora do gate).
 * ATENÇÃO: /assinatura-bloqueada precisa continuar FORA do grupo (app) — se
 * a tela voltar para dentro do grupo, este layout a envolve e volta a
 * redirecionar para ela mesma, em loop infinito (correção do loop de
 * suspensão; regressão travada em tests/assinatura-gate.test.ts).
 */
function AssinaturaBloqueada(): never {
  redirect("/assinatura-bloqueada");
}

/** Banner fixo de vencimento proximo (5 dias) — servia de aviso antes do gate. */
function AvisoVencimento({ dias }: { dias: number | null }) {
  if (dias === null) return null;
  return (
    <div className="fixed bottom-16 left-1/2 z-40 -translate-x-1/2 rounded-full bg-amber-500 px-4 py-2 text-xs font-bold text-white shadow-lg sm:bottom-5">
      ⏳ Sua assinatura vence em {dias} dia{dias === 1 ? "" : "s"}. Renove em /faturamento.
    </div>
  );
}
