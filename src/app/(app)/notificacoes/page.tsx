import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { all, scalar } from "@/lib/db";
import { NOTIFICATION_TYPES } from "@/lib/push-rules";
import { Empty, PageHeader } from "@/components/ui";
import { SubmitButton } from "@/components/SubmitButton";
import { markPersonalRead } from "./push-actions";

export default async function NotificationsPage({searchParams}:{searchParams:Promise<{tipo?:string;lidos?:string;antes?:string}>}) {
  const user = await requireUser();
  const sp = await searchParams;
  const type = sp.tipo && sp.tipo in NOTIFICATION_TYPES ? sp.tipo : "";
  const before = Number(sp.antes) || Number.MAX_SAFE_INTEGER;
  const notifications = await all<{id:number;type:string;title:string;body:string;link:string;created_at:number;read_at:number|null}>(`SELECT * FROM user_notifications WHERE user_id=? AND id<? ${type?"AND type=?":""} ${sp.lidos==="nao"?"AND read_at IS NULL":""} ORDER BY id DESC LIMIT 50`,type?[user.id,before,type]:[user.id,before]);
  const unread = await scalar<number>("SELECT COUNT(*) FROM user_notifications WHERE user_id=? AND read_at IS NULL",[user.id]);
  return <div className="space-y-4">
    <PageHeader title="Minhas Notificações" subtitle={`${unread} não lida(s) · histórico pessoal, mesmo com push desativado`} action={<form action={markPersonalRead}><SubmitButton variant="secundario">Marcar todas como lidas</SubmitButton></form>}/>
    <div className="flex flex-wrap gap-3 text-sm text-marca-600 underline"><Link href="/notificacoes/preferencias">Dispositivos e preferências</Link><Link href="/notificacoes/atividades">Atividades e separação</Link><Link href="/notificacoes/alertas">Alertas gerais existentes</Link></div>
    <form className="pilha-filtros"><select name="tipo" defaultValue={type} className="campo min-w-0 flex-1 basis-48 sm:flex-none sm:max-w-60"><option value="">Todos os tipos</option>{Object.entries(NOTIFICATION_TYPES).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select><select name="lidos" defaultValue={sp.lidos??"todos"} className="campo min-w-0 flex-1 basis-36 sm:flex-none sm:max-w-44"><option value="todos">Lidas e não lidas</option><option value="nao">Não lidas</option></select><button className="w-full rounded-xl border px-4 py-2 sm:w-auto">Filtrar</button></form>
    {!notifications.length && <Empty>Nenhum aviso neste filtro. Configure suas funções, atribuições e preferências para receber novas atividades.</Empty>}
    {notifications.map(n=><article key={n.id} className={`cartao p-4 ${n.read_at?"opacity-70":"border-marca-300"}`}><h2 className="font-bold">{n.title}</h2><p className="text-sm text-stone-600">{n.body}</p><p className="text-xs text-stone-500 mt-1">{new Date(n.created_at*1000).toLocaleString("pt-BR",{timeZone:"America/Sao_Paulo"})}</p><div className="flex gap-3 mt-2"><Link href={n.link} className="text-marca-600 underline text-sm">Abrir atividade</Link>{!n.read_at&&<form action={markPersonalRead}><input type="hidden" name="id" value={n.id}/><SubmitButton variant="fantasma" className="px-2 py-0 text-sm">Marcar como lida</SubmitButton></form>}</div></article>)}
    {notifications.length===50&&<Link className="text-marca-600 underline" href={`/notificacoes?${new URLSearchParams({tipo:type,lidos:sp.lidos??"todos",antes:String(notifications.at(-1)!.id)})}`}>Ver mais antigas</Link>}
  </div>;
}
