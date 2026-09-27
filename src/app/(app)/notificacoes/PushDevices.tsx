"use client";
import { useEffect, useState } from "react";
type Device = { id:number;label:string;enabled:number;last_error:string|null };
type State = { devices:Device[];publicKey:string;error?:string };
export default function PushDevices() {
  const [state,setState] = useState<State>({devices:[],publicKey:""});
  const [message,setMessage] = useState("");
  const [busy,setBusy] = useState(false);
  const [supported,setSupported] = useState(false);
  const [permission,setPermission] = useState<NotificationPermission>("default");
  const [label,setLabel] = useState("Meu dispositivo");
  async function load() {
    const response = await fetch("/api/push",{cache:"no-store"});
    const data = await response.json() as State;
    if (!response.ok) throw new Error(data.error || "Falha ao carregar dispositivos.");
    setState(data);
  }
  useEffect(() => {
    setSupported("serviceWorker" in navigator && "PushManager" in window && "Notification" in window);
    if ("Notification" in window) setPermission(Notification.permission);
    void load().catch(e=>setMessage(e.message));
  },[]);
  async function activate() {
    if (!supported || !state.publicKey) return;
    setBusy(true); setMessage("");
    try {
      // Must stay inside an explicit user gesture (particularly Safari/iOS).
      const permission = await Notification.requestPermission();
      setPermission(permission);
      if (permission!=="granted") throw new Error("Permissão não concedida. Você pode liberá-la nas configurações do navegador.");
      const registration = await navigator.serviceWorker.register("/sw.js",{scope:"/",updateViaCache:"none"});
      await navigator.serviceWorker.ready;
      const raw = atob(state.publicKey.replace(/-/g,"+").replace(/_/g,"/"));
      const key = Uint8Array.from(raw,c=>c.charCodeAt(0));
      let subscription = await registration.pushManager.getSubscription();
      if (!subscription) subscription = await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:key});
      const response = await fetch("/api/push",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"subscribe",label,subscription:subscription.toJSON()})});
      const data = await response.json() as {error?:string;resetLocal?:boolean};
      if (!response.ok) { if(data.resetLocal) await subscription.unsubscribe(); throw new Error(data.error); }
      setMessage("Dispositivo ativado. Os avisos seguem suas funções, atribuições e preferências."); await load();
    } catch(e) { setMessage(e instanceof Error?e.message:"Não foi possível ativar."); }
    finally { setBusy(false); }
  }
  async function disable(id:number) {
    setBusy(true);
    try {
      const response = await fetch("/api/push",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"disable",id})});
      if(!response.ok) throw new Error("Falha ao desativar. Tente novamente.");
      await load(); setMessage("Push desativado somente neste dispositivo. Seu histórico e atividades continuam disponíveis.");
    } catch(e) { setMessage(e instanceof Error?e.message:"Falha de conexao."); }
    finally { setBusy(false); }
  }
  return <section className="cartao p-4 space-y-3">
    <h2 className="font-bold">Notificações neste aparelho</h2>
    <p className="text-sm text-stone-600">No iPhone/iPad (iOS 16.4+), abra no Safari, use Compartilhar → Adicionar a Tela de Inicio e abra pelo icone antes de ativar. Android e desktop: use um navegador com Web Push. Som, vibracao e exibicao dependem do sistema, modo silencioso e permissao.</p>
    {!supported && <p className="text-sm text-amber-700">Push indisponível neste contexto. No iOS, abra o aplicativo instalado na tela inicial. A central interna continua funcionando.</p>}
    {permission==="denied" && <p className="text-sm text-amber-700">Permissão bloqueada. Libere notificações nas configurações deste site no navegador.</p>}
    {!state.publicKey && <p className="text-sm text-amber-700">Servidor push ainda não configurado.</p>}
    <label className="block text-sm">Nome deste dispositivo<input className="campo mt-1" value={label} onChange={e=>setLabel(e.target.value)} maxLength={80}/></label>
    <button type="button" disabled={busy||!supported||!state.publicKey} onClick={activate} className="rounded-xl bg-marca-600 text-white px-4 py-2 font-semibold disabled:opacity-50">Ativar / reativar neste aparelho</button>
    {message && <p role="status" className="text-sm">{message}</p>}
    <h3 className="font-semibold text-sm">Meus dispositivos</h3>
    {state.devices.length===0 && <p className="text-sm text-stone-500">Nenhum dispositivo inscrito.</p>}
    {state.devices.map(d=><div key={d.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border p-3 text-sm">
      <span>{d.label} · {d.enabled?"Ativo":"Desativado"}{d.last_error && <small className="block text-amber-700">{d.last_error}</small>}</span>
      {d.enabled ? <button disabled={busy} onClick={()=>disable(d.id)} className="text-red-700 underline">Desativar este dispositivo</button> : <span className="text-xs">Reative abrindo o sistema nesse aparelho.</span>}
    </div>)}
  </section>;
}
