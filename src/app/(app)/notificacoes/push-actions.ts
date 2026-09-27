"use server";
import { revalidatePath } from "next/cache";
import { assertAdmin, requireUser } from "@/lib/auth";
import { all, batch, one, run } from "@/lib/db";
import { logAction } from "@/lib/audit";
import { NOTIFICATION_TYPES, validOffsets } from "@/lib/push-rules";

export async function markPersonalRead(fd: FormData) {
  const user = await requireUser();
  const id = Number(fd.get("id"));
  await run(`UPDATE user_notifications SET read_at=unixepoch() WHERE user_id=? AND read_at IS NULL ${id?"AND id=?":""}`,id?[user.id,id]:[user.id]);
  revalidatePath("/notificacoes");
}
export async function savePreferences(fd: FormData) {
  const user = await requireUser();
  const values = Object.keys(NOTIFICATION_TYPES).map(type=>{
    const mode = String(fd.get(type) ?? "auto");
    if (!["auto","on","off"].includes(mode)) throw new Error("Preferência inválida.");
    return {sql:"INSERT INTO notification_preferences(user_id,type,mode) VALUES (?,?,?) ON CONFLICT(user_id,type) DO UPDATE SET mode=excluded.mode",params:[user.id,type,mode]};
  });
  await batch(values);
  revalidatePath("/notificacoes/preferencias");
}
export async function saveRoles(fd: FormData) {
  const admin = await assertAdmin();
  const id = Number(fd.get("user_id"));
  if (!await one("SELECT id FROM users WHERE id=?",[id])) throw new Error("Usuario inexistente.");
  const allowed = (await all<{key:string}>("SELECT key FROM operational_roles")).map(r=>r.key);
  const roles = [...new Set(fd.getAll("roles").map(String))];
  if (roles.some(r=>!allowed.includes(r))) throw new Error("Função inválida.");
  await batch([{sql:"DELETE FROM user_operational_roles WHERE user_id=?",params:[id]},...roles.map(role=>({sql:"INSERT INTO user_operational_roles(user_id,role) VALUES (?,?)",params:[id,role]}))]);
  await logAction(admin,"editar","usuario",id,`${admin.name} atualizou funcoes operacionais`,{roles});
  revalidatePath("/notificacoes/preferencias");
}
export async function savePushRules(fd: FormData) {
  const admin = await assertAdmin();
  const rules = Object.keys(NOTIFICATION_TYPES).map(type=>({
    sql:"UPDATE notification_rules SET enabled=?,offsets=?,message=? WHERE type=?",
    params:[fd.get(`enabled:${type}`)==="on"?1:0,JSON.stringify(validOffsets(fd.getAll(`offset:${type}`).map(Number))),String(fd.get(`message:${type}`)??"").slice(0,500),type],
  }));
  await batch([{sql:"INSERT INTO settings(key,value) VALUES ('push_enabled',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params:[fd.get("push_enabled")==="on"?"1":"0"]},...rules]);
  await logAction(admin,"editar","configuracao",null,`${admin.name} atualizou regras de notificacoes`);
  revalidatePath("/notificacoes/preferencias");
}
export async function updateActivity(fd: FormData) {
  const user = await requireUser();
  const id = Number(fd.get("id"));
  const activity = await one<{source:string;source_id:number;assignee_id:number|null;status:string}>("SELECT * FROM activities WHERE id=?",[id]);
  if (!activity) throw new Error("Atividade inexistente.");
  const manager = user.role==="admin" || !!await one("SELECT 1 FROM user_operational_roles WHERE user_id=? AND role='gestor'",[user.id]);
  if (!manager) throw new Error("Somente administrador ou gestor operacional pode alterar a atribuicao.");
  const assignee = Number(fd.get("assignee_id")) || null;
  if (assignee && !await one("SELECT id FROM users WHERE id=? AND active=1",[assignee])) throw new Error("Responsavel inativo ou inexistente.");
  if (activity.source==="operations") {
    await run("UPDATE operations SET assignee_id=?,assignee=COALESCE((SELECT name FROM users WHERE id=?),'') WHERE id=?",[assignee,assignee,activity.source_id]);
  } else {
    await run("UPDATE activities SET assignee_id=?,revision=revision+1 WHERE id=? AND assignee_id IS NOT ?",[assignee,id,assignee]);
  }
  await logAction(user,"editar","atividade",id,`${user.name} alterou o responsavel da atividade`,{assignee});
  revalidatePath("/notificacoes/atividades"); revalidatePath("/operacao");
}
export async function completeSeparation(fd: FormData) {
  const user = await requireUser();
  const id = Number(fd.get("id"));
  const a = await one<{assignee_id:number|null}>("SELECT assignee_id FROM activities WHERE id=? AND kind='separacao' AND status='pending'",[id]);
  if (!a) return;
  const roles = await all<{role:string}>("SELECT role FROM user_operational_roles WHERE user_id=?",[user.id]);
  if (user.role!=="admin" && a.assignee_id!==user.id && !roles.some(r=>r.role==="gestor" || (a.assignee_id===null && r.role==="separador"))) throw new Error("Você não é responsável por esta separação.");
  await run("UPDATE activities SET status='completed',revision=revision+1 WHERE id=? AND status='pending'",[id]);
  await logAction(user,"concluir","atividade",id,`${user.name} concluiu a separacao dos materiais`);
  revalidatePath("/notificacoes/atividades");
}
