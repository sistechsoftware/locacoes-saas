import Link from "next/link";
import { all, one } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { NOTIFICATION_TYPES, type Activity } from "@/lib/push-rules";
import { Empty, PageHeader } from "@/components/ui";
import { SubmitButton } from "@/components/SubmitButton";
import { completeSeparation, updateActivity } from "../push-actions";

export default async function ActivitiesPage({searchParams}:{searchParams:Promise<{reserva?:string;tipo?:string;estado?:string}>}) {
  const user = await requireUser();
  const sp = await searchParams;
  const roles = await all<{role:string}>("SELECT role FROM user_operational_roles WHERE user_id=?",[user.id]);
  const manager = user.role==="admin" || roles.some(r=>r.role==="gestor");
  const users = await all<{id:number;name:string}>("SELECT id,name FROM users WHERE active=1 ORDER BY name");
  const params:(number|string)[]=[];
  let filter="";
  if (Number(sp.reserva)) { filter+=" AND a.reservation_id=?"; params.push(Number(sp.reserva)); }
  if (sp.tipo && sp.tipo in NOTIFICATION_TYPES) { filter+=" AND a.kind=?"; params.push(sp.tipo); }
  if (sp.estado!=="todos") filter+=" AND a.status='pending'";
  const activities = await all<Activity & {source:string;source_id:number;reservation_id:number|null;assignee_name:string}>(`SELECT a.*,u.name AS assignee_name FROM activities a LEFT JOIN users u ON u.id=a.assignee_id WHERE 1=1 ${filter} ORDER BY a.scheduled_at DESC LIMIT 100`,params);
  const items = Number(sp.reserva) ? await all<{name:string;qty:number}>(`SELECT p.name,SUM(c.qty) AS qty FROM reservation_item_components c JOIN products p ON p.id=c.product_id WHERE c.reservation_id=? GROUP BY p.id ORDER BY p.name`,[Number(sp.reserva)]) : [];
  return <div className="space-y-4"><PageHeader title="Atividades Operacionais" subtitle="Atribuição direta, agenda integrada e separação de materiais"/>
    <Link href="/notificacoes" className="text-marca-600 underline">Central de Notificações</Link>
    <form className="flex flex-wrap gap-2"><select name="tipo" defaultValue={sp.tipo??""} className="campo max-w-56"><option value="">Todos os tipos</option>{Object.entries(NOTIFICATION_TYPES).filter(([k])=>!["alteracao","cancelamento"].includes(k)).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select><select name="estado" className="campo max-w-44" defaultValue={sp.estado??"pending"}><option value="pending">Pendentes</option><option value="todos">Todos os estados</option></select>{sp.reserva&&<input type="hidden" name="reserva" value={sp.reserva}/>}<button className="border rounded-xl px-4">Filtrar</button></form>
    {!!sp.reserva && <section className="cartao p-4"><h2 className="font-bold">Materiais Físicos da Reserva</h2><p className="text-sm text-stone-500">Kits expandidos pela composição salva na reserva. Concluir a separação não movimenta nem duplica estoque.</p><ul className="mt-2 space-y-1">{items.map(i=><li key={i.name}>{i.qty} × {i.name}</li>)}</ul><Link href={`/reservas/${Number(sp.reserva)}`} className="text-marca-600 underline text-sm">Conferir reserva e itens comerciais</Link></section>}
    {!activities.length&&<Empty>Nenhuma atividade neste filtro.</Empty>}
    {activities.map(a=><article key={a.id} id={`atividade-${a.id}`} className="cartao p-4 space-y-2"><h2 className="font-bold">{a.title}</h2><p className="text-sm">{a.scheduled_at.replace("T"," ")} · {a.status==="pending"?"Pendente":a.status==="completed"?"Concluída":"Cancelada"} · {a.assignee_name||"Equipe pelas funções"}</p>
      <Link href={a.kind==="separacao"?`/notificacoes/atividades?reserva=${a.reservation_id}&estado=todos#atividade-${a.id}`:a.link} className="text-marca-600 underline text-sm">{a.kind==="separacao"?"Conferir materiais":"Abrir registro de origem"}</Link>
      {manager&&<form action={updateActivity} className="flex flex-wrap gap-2"><input type="hidden" name="id" value={a.id}/><select aria-label="Responsável exclusivo" name="assignee_id" className="campo max-w-xs" defaultValue={a.assignee_id??""}><option value="">Equipe pelas funções</option>{users.map(u=><option key={u.id} value={u.id}>{u.name}</option>)}</select><SubmitButton variant="secundario">Atribuir responsável</SubmitButton></form>}
      {a.kind==="separacao"&&a.status==="pending"&&(manager||a.assignee_id===user.id||a.assignee_id===null&&roles.some(r=>r.role==="separador"))&&<form action={completeSeparation}><input type="hidden" name="id" value={a.id}/><SubmitButton variant="sucesso" confirm="Materiais e quantidades conferidos?">Concluir separação</SubmitButton></form>}
    </article>)}
    {activities.length===100&&<p className="text-sm text-stone-500">Mostrando as 100 atividades mais recentes. Filtre por tipo ou abra uma reserva para localizar suas atividades.</p>}
  </div>;
}
