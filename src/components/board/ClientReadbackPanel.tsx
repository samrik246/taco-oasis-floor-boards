"use client";
import {useEffect,useState} from "react";
import {clientIdentity,measureClient,postClientReadback} from "@/lib/quarter/client/readback";
import {ManagerUnlockModal} from "./ManagerUnlockModal";
import {messagesFor,type Locale} from "@/lib/i18n";

/** Operator-only rollout view, requested explicitly with ?readback=1 on the actual display. */
export function ClientReadbackPanel({board,role,view,locale}:{board:"caja"|"cocina";role:"floor"|"wall"|"editor";view:string;locale:Locale}){
  const [id,setId]=useState(""),[token,setToken]=useState<string|null>(null),[login,setLogin]=useState(false),[label,setLabel]=useState(""),[inventory,setInventory]=useState<unknown>(null),[closed,setClosed]=useState(false),[message,setMessage]=useState(""),[receipt,setReceipt]=useState<unknown>(null);
  useEffect(()=>{void clientIdentity().then(setId).catch(e=>setMessage(e.message));},[]);
  async function measure(){if(!token||!inventory||!closed)return;try{
    const challenge=await postClientReadback(token,{action:"issue",inventory,label});
    const measurement=await measureClient(challenge,role,board);
    const result=await postClientReadback(token,{action:"answer",measurement,visible:{label,clientInstanceId:id,board,view,oldTabsClosed:true,observedAt:new Date().toISOString()}});
    setReceipt(result);setMessage(locale==="es"?"Lectura guardada para revisión.":"Readback saved for review.");
  }catch(e){setMessage(e instanceof Error?e.message:String(e));}}
  function download(){const url=URL.createObjectURL(new Blob([JSON.stringify(receipt,null,2)],{type:"application/json"})),a=document.createElement("a");a.href=url;a.download="client-readback.json";a.click();URL.revokeObjectURL(url);}
  return <section className="m-3 rounded border-2 border-neutral-800 bg-white p-3 text-base text-neutral-950" data-testid="quarter-client-readback">
    <p>{locale==="es"?"Revisión de este dispositivo":"Device readback"}: <span data-testid="client-instance-id">{id}</span> · {board} · {role} · {view}</p>
    <label>{locale==="es"?"Inventario aprobado":"Reviewed inventory"}<input type="file" accept="application/json" onChange={e=>{const file=e.target.files?.[0];if(file)void file.text().then(text=>setInventory(JSON.parse(text))).catch(e=>setMessage(e.message));}} /></label>
    <label>{locale==="es"?"Etiqueta del dispositivo":"Device label"}<input className="border-2" value={label} onChange={e=>setLabel(e.target.value)} /></label>
    <label className="block"><input type="checkbox" checked={closed} onChange={e=>setClosed(e.target.checked)} />{locale==="es"?"Comparé la pantalla y el ID con el inventario y cerré las pestañas anteriores.":"I matched the display and ID to the inventory and closed older tabs."}</label>
    {!token?<button className="min-h-11 border-2 px-3" onClick={()=>setLogin(true)}>{locale==="es"?"Entrar como propietario":"Owner sign in"}</button>:<button className="min-h-11 border-2 px-3" disabled={!id||!inventory||!label||!closed} onClick={()=>void measure()}>{locale==="es"?"Registrar lectura":"Record readback"}</button>}
    {receipt!==null&&<button className="min-h-11 border-2 px-3" onClick={download}>{locale==="es"?"Guardar comprobante":"Save receipt"}</button>}{message&&<p role="status">{message}</p>}
    <ManagerUnlockModal open={login} t={messagesFor(locale)} onCancel={()=>setLogin(false)} onUnlocked={session=>{setLogin(false);if(session.role!=="owner"){setMessage("Owner required");return;}setToken(session.token);}} />
  </section>;
}
