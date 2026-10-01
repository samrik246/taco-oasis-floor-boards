"use client";
import {useCallback,useEffect,useState} from "react";
import {DraftDatabase} from "@/lib/quarter/client/draft-db";
import {resumeAction} from "@/lib/quarter/client/controls";
import type {DraftScope} from "@/lib/quarter/client/draft-types";
import type {Locale} from "@/lib/i18n";

export function PendingQuarterActions({managerId,board,date,token,locale,readonly,onSaved}:{managerId:string;board:DraftScope["board"];date:string;token:string|null;locale:Locale;readonly:boolean;onSaved:()=>Promise<void>}){
  const [rows,setRows]=useState<{key:string;description:string;bytes:string}[]>([]),[message,setMessage]=useState(""),[busy,setBusy]=useState(false),[reviewOnly,setReviewOnly]=useState(false);
  const refresh=useCallback(async()=>{
    const db=await DraftDatabase.open();try{
      setReviewOnly(db.readOnly||(await db.read({managerId,board,date})).warnings.length>0);
      const pending=await db.pendingCommands({managerId,board,date});
      setRows(pending.map(row=>{const body=JSON.parse(row.value.requestBytes);return {key:row.key,bytes:row.value.requestBytes,description:[body.operation??body.action,body.shiftId??body.employeeId??body.removalId,body.reason].filter(Boolean).join(" · ")};}));
    }finally{db.close();}
  },[managerId,board,date]);
  useEffect(()=>{let current=true;const load=()=>{if(current)void refresh().catch(e=>setMessage(e.message));};load();window.addEventListener("quarter-commands-changed",load);window.addEventListener("focus",load);return()=>{current=false;window.removeEventListener("quarter-commands-changed",load);window.removeEventListener("focus",load);};},[refresh]);
  async function retry(key:string){setBusy(true);try{
    const result=await resumeAction({managerId,board,date},key,token);
    setMessage(result.status==="saved"?(locale==="es"?"Guardado confirmado.":"Save confirmed."):result.status==="cleanup-pending"?(locale==="es"?"Guardado; limpieza local pendiente.":"Saved; local cleanup pending."):
      result.status==="rejected"?(locale==="es"?"Rechazado; solicitud original conservada para revisión.":"Rejected; original request retained for review."):(locale==="es"?"Sin confirmar; solicitud conservada.":"Unconfirmed; request retained."));
    if(result.body?.ok)await onSaved();await refresh();
  }catch(e){setMessage(e instanceof Error?e.message:String(e));}finally{setBusy(false);}}
  if(!rows.length&&!message)return null;
  return <section data-testid="quarter-pending-actions" className="m-3 rounded-lg border-2 border-amber-700 bg-amber-50 p-3 text-neutral-950">
    {rows.length>0&&<p>{locale==="es"?"Acciones sin confirmar. Reintentar conserva la solicitud original.":"Unconfirmed actions. Retry uses the original request."}</p>}
    {reviewOnly&&<p role="alert">{locale==="es"?"Solo revisión: el almacenamiento necesita revisión. Las solicitudes originales están conservadas; no se pueden reintentar.":"Review only: storage needs review. Original requests are preserved; retries are disabled."}</p>}
    {rows.map(row=><div key={row.key} className="flex flex-wrap items-center gap-3"><span>{row.description}</span><button type="button" className="min-h-11 rounded border-2 px-3 font-bold" disabled={busy||readonly||reviewOnly} onClick={()=>void retry(row.key)}>{locale==="es"?"Revisar / reintentar":"Check / retry"}</button>{reviewOnly&&<details><summary>{locale==="es"?"Ver solicitud original":"View original request"}</summary><pre className="overflow-auto text-xs">{row.bytes}</pre></details>}</div>)}
    {message&&<p role="status">{message}</p>}
  </section>;
}
