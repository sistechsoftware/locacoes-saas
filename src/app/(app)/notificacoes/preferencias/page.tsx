import Link from "next/link";
import { requireUser, listUsers } from "@/lib/auth";
import { all, one } from "@/lib/db";
import { NOTIFICATION_TYPES, OFFSETS } from "@/lib/push-rules";
import { PageHeader, Section } from "@/components/ui";
import { SubmitButton } from "@/components/SubmitButton";
import PushDevices from "../PushDevices";
import PushDiagnostico from "../PushDiagnostico";
import { savePreferences, savePushRules, saveRoles } from "../push-actions";

export default async function PreferencesPage() {
  const user = await requireUser();
  const prefs = await all<{type:string;mode:string}>("SELECT type,mode FROM notification_preferences WHERE user_id=?",[user.id]);
  const roles = await all<{key:string;label:string}>("SELECT * FROM operational_roles");
  const assignments = await all<{user_id:number;role:string}>("SELECT * FROM user_operational_roles");
  const rules = user.role==="admin" ? await all<{type:string;enabled:number;offsets:string;message:string}>("SELECT * FROM notification_rules") : [];
  const users = user.role==="admin" ? await listUsers() : [];
  const enabled = await one<{value:string}>("SELECT value FROM settings WHERE key='push_enabled'");
  const lastRun = await one<{value:string}>("SELECT value FROM scheduler_state WHERE key='last_run'");
  return <div className="space-y-4">
    <PageHeader title="Preferências de Notificação" subtitle="Por tipo, função e dispositivo" />
    <Link href="/notificacoes" className="text-marca-600 underline">Voltar à central</Link>
    <PushDevices />
    <PushDiagnostico />
    <Section title="O que quero receber">
      <p className="mb-3 text-sm text-stone-600">Automatico segue suas funcoes e atribuicoes. Ativar explicitamente inclui o tipo mesmo sem funcao quando nao ha responsavel exclusivo. Desativar bloqueia novos avisos desse tipo, sem apagar historico. Um responsavel definido recebe com exclusividade, respeitando suas preferencias.</p>
      <p className="mb-3 text-sm">Minhas funcoes: {roles.filter(r=>assignments.some(a=>a.user_id===user.id&&a.role===r.key)).map(r=>r.label).join(", ") || "nenhuma definida"}. Ser administrador não inscreve você em avisos.</p>
      <form action={savePreferences} className="space-y-3">
        {Object.entries(NOTIFICATION_TYPES).map(([type,label])=><label key={type} className="flex items-center justify-between gap-3 text-sm">{label}<select name={type} defaultValue={prefs.find(p=>p.type===type)?.mode??"auto"} className="campo max-w-56"><option value="auto">Automático (função/atribuição)</option><option value="on">Ativar explicitamente</option><option value="off">Desativar</option></select></label>)}
        <SubmitButton>Salvar Preferências</SubmitButton>
      </form>
    </Section>
    {user.role==="admin" && <>
      <Section title="Funções Operacionais dos Usuários">
        <p className="text-sm text-stone-600 mb-3">Funções independentes das permissões de acesso. Um usuário pode ter várias funções.</p>
        {users.map(u=><form key={u.id} action={saveRoles} className="border rounded-xl p-3 mb-3 space-y-2"><input type="hidden" name="user_id" value={u.id}/><h3 className="font-bold">{u.name} · {u.role}{!u.active&&" (inativo)"}</h3><div className="flex flex-wrap gap-3">{roles.map(r=><label key={r.key} className="text-sm flex items-center gap-1"><input type="checkbox" name="roles" value={r.key} defaultChecked={assignments.some(a=>a.user_id===u.id&&a.role===r.key)}/>{r.label}</label>)}</div><SubmitButton variant="secundario">Salvar Funções</SubmitButton></form>)}
      </Section>
      <Section title="Regras Gerais e Antecedentes">
        <p className="text-sm text-stone-600 mb-3">Agendador no servidor: {lastRun?new Date(Number(lastRun.value)*1000).toLocaleString("pt-BR",{timeZone:"America/Sao_Paulo"}):"aguardando primeira execução"}. Lembretes têm precisão de aproximadamente um minuto, sujeitos ao navegador e à rede.</p>
        <form action={savePushRules} className="space-y-4">
          <label className="flex gap-2"><input type="checkbox" name="push_enabled" defaultChecked={enabled?.value!=="0"}/>Habilitar envio push global (não interrompe a central interna)</label>
          {rules.map(r=><fieldset key={r.type} className="border rounded-xl p-3 space-y-2"><legend className="font-semibold">{NOTIFICATION_TYPES[r.type as keyof typeof NOTIFICATION_TYPES]}</legend>
            <label className="flex gap-2 text-sm"><input type="checkbox" name={`enabled:${r.type}`} defaultChecked={!!r.enabled}/>Enviar push deste tipo</label>
            {!["alteracao","cancelamento"].includes(r.type)&&<div className="flex flex-wrap gap-3">{OFFSETS.map(minutes=><label key={minutes} className="text-sm flex gap-1"><input type="checkbox" name={`offset:${r.type}`} value={minutes} defaultChecked={JSON.parse(r.offsets).includes(minutes)}/>{minutes===0?"No horário":minutes>=60?`${minutes/60}h antes`:`${minutes}min antes`}</label>)}</div>}
            <label className="block text-sm">Mensagem opcional (vazio usa os dados da atividade)<input name={`message:${r.type}`} defaultValue={r.message} maxLength={500} className="campo mt-1"/></label>
          </fieldset>)}
          <SubmitButton>Salvar Regras Gerais</SubmitButton>
        </form>
      </Section>
    </>}
  </div>;
}
