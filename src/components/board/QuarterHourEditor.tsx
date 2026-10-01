"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { showDescansoButton } from "@/lib/breaks/picker-steps";
import { chicagoYmd } from "@/lib/schedule/build-schedule";
import { formatCompactHour,hourGridHours } from "@/lib/hour-grid";
import { paletteSlots,PAINT_FAMILY_LABELS } from "@/lib/assignments/paint-families";
import { activeGeneration, conflictBranches, DraftDatabase } from "@/lib/quarter/client/draft-db";
import { generation,newEnvelope,type DraftGeneration,type DraftScope,type DraftSnapshot } from "@/lib/quarter/client/draft-types";
import { hourEditRefusal,proposeHour } from "@/lib/quarter/client/edit";
import { capabilities, matchCapabilities, sendSubmission } from "@/lib/quarter/client/transport";
import { observeV1 } from "@/lib/quarter/client/v1-conversion";
import { canonicalJson } from "@/lib/quarter/client/primitives";
import { ManagerBreakDialog } from "@/components/breaks/ManagerBreakDialog";
import { OverlayMenu } from "./OverlayMenu";
import { SavedCoverPanel,SavedCoverRows,SavedShiftHour } from "./SavedCoverDisplay";
import { displayName,stationColorClass } from "./board-helpers";
import type { ColorEditorProps } from "./ManagerColorEditor";
const empty:DraftSnapshot={head:null,generations:[],submissions:[],archives:[],warnings:[]};
const explanation=(code:string,es:boolean)=>({HOUR_NEEDS_QUARTER:es?"Hora mixta: se necesita edición por cuartos. Se conserva sin cambios.":"Mixed hour: quarter editing is required. Saved intervals are preserved.",
 HOUR_HAS_OBLIGATION:es?"Esta hora tiene un BREAK o movimiento guardado. Revísalo antes de pintar.":"This hour has a saved BREAK or movement. Review it before painting.",
 QUARTER_DRAFT_REVIEW_ONLY:es?"Este borrador contiene cuartos; se conserva completo para revisión o reintento exacto.":"This draft contains quarters; it is retained in full for review or exact retry.",
 SOURCE_NOT_AVAILABLE:es?"Fuera del turno disponible.":"Outside the available shift."}[code]??code);

/** R0 reads every interval; new editing is explicitly limited to safe uniform hours. */
export function QuarterHourEditor(props:ColorEditorProps){
  const {day,locale,managerId,managerToken,board,date,onSaved,onDraftChange,selectedHour,onSelectHour,readonly}=props;
  const es=locale==="es",publicDay=day?.quarter??day?.bridge;
  const scope:DraftScope={managerId,board,date};
  const db=useRef<DraftDatabase|null>(null), latest=useRef(publicDay),pendingMemory=useRef<DraftGeneration|null>(null);
  useEffect(()=>{latest.current=publicDay;},[publicDay]);
  const [confirmedIntentIds,setConfirmedIntentIds]=useState<string[]>([]);
  const [pendingPreview,setPendingPreview]=useState<DraftGeneration|null>(null);
  const [unretained,setUnretained]=useState(false),[cleanupPending,setCleanupPending]=useState(false);
  const [snapshot,setSnapshot]=useState(empty),[feedback,setFeedback]=useState(""),[busy,setBusy]=useState(false),[ready,setReady]=useState(false);
  const [choice,setChoice]=useState<string|null>(null),[breakTarget,setBreakTarget]=useState<{employeeId:string;name:string}|null>(null);
  const current=activeGeneration(snapshot),branches=conflictBranches(snapshot),intents=(current?.envelope.intents??[]).filter(i=>!confirmedIntentIds.includes(i.intentId));
  const refresh=useCallback(async()=>{
    if(!db.current)return;
    const observed=latest.current?await observeV1(db.current,{managerId,board,date},latest.current):{changed:false,snapshot:await db.current.read({managerId,board,date})};
    setSnapshot(observed.snapshot);
    if(observed.changed)setFeedback(es?"Otra pestaña cambió el borrador anterior; revisa las dos copias.":"Another tab changed the old draft; review both retained copies.");
    const requestId=observed.snapshot.head?.pendingRequestId;
    const submission=observed.snapshot.submissions.find(s=>s.requestId===requestId);
    if(submission){
      const outcome=await sendSubmission(db.current,{managerId,board,date},submission,managerToken,true);
      if(outcome.status==="saved"||outcome.status==="cleanup-pending"){
        setFeedback(outcome.status==="saved"?(es?"Guardado.":"Saved."):(es?"Guardado; limpieza local pendiente.":"Saved; local cleanup pending."));
        setConfirmedIntentIds(outcome.status==="cleanup-pending"?submission.submittedIntentIds:[]);
        setCleanupPending(outcome.status==="cleanup-pending");
        if(outcome.status==="saved")setSnapshot(await db.current.read({managerId,board,date}));
      }else setFeedback(es?"Estado de guardado desconocido. Se conserva la solicitud original.":"Save status unknown. The original request is retained.");
      return outcome;
    }
  },[managerId,board,date,managerToken,es]);
  useEffect(()=>{
    let live=true,connection:DraftDatabase|null=null;
    void DraftDatabase.open(code=>{if(live){setFeedback(code);setReady(false);}}).then(async store=>{
      if(!live){store.close();return;}connection=store;db.current=store;await refresh();if(live)setReady(true);
    }).catch(error=>{if(live)setFeedback(`${es?"No retenido":"Not retained"}: ${error.message}`);});
    const focus=()=>{if(!pendingMemory.current)void refresh().catch(error=>setFeedback(error.message));};
    window.addEventListener("focus",focus);
    return ()=>{live=false;window.removeEventListener("focus",focus);connection?.close();db.current=null;};
  },[refresh,es]);
  async function run(action:()=>Promise<unknown>){setBusy(true);try{await action();onDraftChange();}catch(error){setFeedback(`${es?"No retenido / requiere revisión":"Not retained / review required"}: ${error instanceof Error?error.message:String(error)}`);}finally{setBusy(false);}}
  async function stage(shiftId:string,hour:number){
    if(!db.current||!publicDay||!choice||readonly||!ready||cleanupPending||pendingMemory.current)return;
    await run(async()=>{
      const cap=await capabilities();matchCapabilities(cap,publicDay);
      const action=choice==="erase"?{action:"erase" as const}:choice.startsWith("family:")?{action:"family" as const,family:choice.slice(7)}:{action:"station" as const,stationId:choice};
      // The visible base remains the CAS expectation even if another tab has advanced.
      await db.current!.read(scope);
      const {base,proposal}=proposeHour(scope,snapshot,publicDay,shiftId,hour,action);
      pendingMemory.current=proposal;setPendingPreview(proposal);setUnretained(true);
      const result=await db.current!.retain(scope,base,proposal);pendingMemory.current=null;setPendingPreview(null);setUnretained(false);setSnapshot(result.snapshot);
      setFeedback(result.status==="conflict"?(es?"Conflicto: ambas versiones están retenidas.":"Conflict: both versions are retained."):(es?"Retenido localmente; aún sin guardar.":"Locally retained; not yet saved."));
    });
  }
  async function save(){if(!db.current||!publicDay||readonly||pendingMemory.current)return;await run(async()=>{
    const reconciled=await refresh();
    if(reconciled?.receipt){await onSaved();return;}
    const fresh=await db.current!.read(scope);
    if(conflictBranches(fresh).length||fresh.warnings.length)throw new Error("DRAFT_REQUIRES_REVIEW");
    const pending=fresh.submissions.find(s=>s.requestId===fresh.head?.pendingRequestId);
    const cap=await capabilities();
    if(!pending)matchCapabilities(cap,publicDay);
    else if(pending.databaseEpoch!==cap.databaseEpoch)throw new Error("DATABASE_EPOCH_CHANGED");
    const submission=pending??await db.current!.prepare(scope,snapshot.head!,cap.capabilitySha256);
    const result=await sendSubmission(db.current!,scope,submission,managerToken);
    setConfirmedIntentIds(result.status==="cleanup-pending"?submission.submittedIntentIds:[]);
    setCleanupPending(result.status==="cleanup-pending");
    if(result.status!=="cleanup-pending")setSnapshot(await db.current!.read(scope));
    setFeedback(result.status==="saved"?(es?"Guardado.":"Saved."):result.status==="cleanup-pending"?(es?"Guardado; limpieza local pendiente.":"Saved; local cleanup pending."):result.status==="rejected"?`${es?"Rechazado; borrador conservado":"Rejected; draft retained"}: ${result.code}`:(es?"Guardado sin confirmar. Reintentar usa la misma solicitud.":"Save unconfirmed. Retry uses the same request."));
    if(result.receipt)await onSaved();
  });}
  async function resolveBranch(branch:DraftGeneration,useBranch:boolean){if(!db.current||!snapshot.head||snapshot.head.pendingRequestId)return;await run(async()=>{
    const selected=useBranch?branch:current;if(!selected)throw new Error("DRAFT_REQUIRES_REVIEW");
    const envelope=newEnvelope({...selected.envelope,parentGenerationId:snapshot.head!.generationId,parentRevision:snapshot.head!.localRevision,pendingRequestId:null});
    const result=await db.current!.retain(scope,snapshot.head!,generation(scope,envelope,[branch.generationId]));setSnapshot(result.snapshot);
    setFeedback(es?"Selección retenida; las versiones originales se conservan.":"Selection retained; original versions are preserved.");
  });}
  if(!day||!publicDay)return <section><p role="status">{es?"Borrador conservado; el tablero compatible no está disponible.":"Draft retained; compatible board unavailable."}</p><p>{feedback}</p>{snapshot.generations.map(g=><details key={g.generationId}><summary>{es?"Ver borrador retenido":"View retained draft"}</summary><pre>{canonicalJson(g.envelope)}</pre></details>)}</section>;
  return <section className="space-y-3" data-testid="quarter-hour-editor">
    <p className="text-sm">{es?"Esta versión permite pintar horas uniformes. Los intervalos guardados se muestran completos.":"This version edits uniform hours. All saved intervals are shown."}</p>
    <div className="flex flex-wrap gap-2">{paletteSlots(day.stations).map(slot=>{
      const id=slot.kind==="family"?`family:${slot.family}`:slot.id,station=slot.kind==="station"?day.stations.find(s=>s.id===slot.id):null;
      return <button key={id} data-testid={`quarter-palette-${id}`} type="button" aria-pressed={choice===id} onClick={()=>setChoice(id)} className={`min-h-11 rounded border-2 p-2 font-bold ${station?stationColorClass(station.color):"bg-white text-neutral-900"} ${choice===id?"ring-4 ring-neutral-900":""}`}>{slot.kind==="family"?PAINT_FAMILY_LABELS[slot.family]:station?.label}</button>;
    })}<button type="button" className="min-h-11 rounded border-2 p-2" aria-pressed={choice==="erase"} onClick={()=>setChoice("erase")}>{es?"Borrar":"Erase"}</button></div>
    <div className="flex flex-wrap gap-2"><button type="button" data-testid="quarter-save" className="min-h-11 rounded bg-emerald-800 px-4 text-white disabled:opacity-50" disabled={readonly||busy||!ready||unretained||(!intents.length&&!snapshot.head?.pendingRequestId)||branches.length>0||(!snapshot.head?.pendingRequestId&&Boolean(current?.envelope.reviewReasons.length))} onClick={()=>void save()}>{snapshot.head?.pendingRequestId?(es?"Reintentar guardado":"Retry save"):(es?"Guardar":"Save")}</button>
      <button type="button" className="min-h-11 rounded border px-3" disabled={busy||!ready||unretained||Boolean(snapshot.head?.pendingRequestId)||!snapshot.head} onClick={()=>void run(async()=>{const result=await db.current!.discard(scope,snapshot.head!);setSnapshot(result.snapshot);pendingMemory.current=null;setFeedback(result.status==="conflict"?"DRAFT_HEAD_CHANGED":es?"Descartado localmente; historial retenido.":"Locally discarded; history retained.");})}>{es?"Descartar borrador":"Discard draft"}</button>
      <button type="button" className="min-h-11 rounded border px-3" disabled={busy} onClick={()=>void run(refresh)}>{es?"Revisar almacenamiento":"Review retained work"}</button></div>
    <p role="status" className="whitespace-pre-wrap text-sm" data-testid="quarter-draft-status">{feedback}</p>
    {pendingPreview&&<div role="alert"><p>{es?"Este cambio sigue en memoria; aún no está retenido. Mantén esta pestaña abierta.":"This change is still in memory and has not been retained. Keep this tab open."}</p><details><summary>{es?"Ver cambio completo":"View complete change"}</summary><pre>{canonicalJson(pendingPreview.envelope)}</pre></details><button type="button" className="min-h-11 border p-2" disabled={busy||!ready} onClick={()=>void run(async()=>{
      const proposal=pendingMemory.current;if(!proposal||!db.current)return;
      const result=await db.current.retain(scope,{generationId:proposal.envelope.parentGenerationId,localRevision:proposal.envelope.parentRevision},proposal);
      setSnapshot(result.snapshot);pendingMemory.current=null;setPendingPreview(null);setUnretained(false);setFeedback(result.status==="conflict"?"DRAFT_HEAD_CHANGED":es?"Retenido localmente.":"Locally retained.");
    })}>{es?"Reintentar retención":"Retry retention"}</button><button type="button" className="min-h-11 border p-2" disabled={busy} onClick={()=>{pendingMemory.current=null;setPendingPreview(null);setUnretained(false);void run(refresh);}}>{es?"Descartar copia en memoria y revisar almacenamiento":"Discard memory copy and review retained storage"}</button></div>}
    {current?.envelope.reviewReasons.length?<p role="alert">{es?"Revisión necesaria; las expectativas originales no se han cambiado.":"Review required; original expectations have not been changed."} {current.envelope.reviewReasons.join(" · ")}</p>:null}
    {snapshot.warnings.map(w=><p key={w} role="alert">{w}</p>)}
    {intents.length>0&&<p>{intents.length} {es?"cambios privados retenidos":"retained private changes"}</p>}
    {branches.map(branch=><div key={branch.generationId} className="rounded border-2 border-amber-700 p-3"><p>{es?"Otra versión retenida":"Another retained version"}: {branch.envelope.intents.length} {es?"cambios":"changes"}</p><details><summary>{es?"Ver versión original":"View original version"}</summary><pre className="overflow-auto text-xs">{canonicalJson(branch.envelope)}</pre></details><button type="button" className="min-h-11 border p-2" disabled={busy||Boolean(snapshot.head?.pendingRequestId)} onClick={()=>void resolveBranch(branch,true)}>{es?"Elegir esta versión":"Choose this version"}</button><button type="button" className="min-h-11 border p-2" disabled={busy||Boolean(snapshot.head?.pendingRequestId)} onClick={()=>void resolveBranch(branch,false)}>{es?"Conservar versión actual":"Keep current version"}</button></div>)}
    {snapshot.archives.filter(a=>a.result==="review").map(a=><details key={a.v1Sha256}><summary>{es?"Borrador anterior requiere revisión":"Earlier draft requires review"}: {a.staleReason}</summary><pre className="overflow-auto text-xs">{a.original}</pre></details>)}
    <div className="overflow-x-auto"><table className="border-collapse text-xs"><thead><tr><th className="min-w-40">{es?"Persona":"Person"}</th>{hourGridHours().map(h=><th className="min-w-36" key={h}><button type="button" className="min-h-11 w-full" aria-pressed={selectedHour===h} onClick={()=>onSelectHour(h)}>{formatCompactHour(h)}</button></th>)}</tr></thead><tbody>
      {day.shifts.map(shift=><tr key={shift.id}><th className="sticky left-0 z-10 bg-white text-left"><span>{displayName(shift)}</span>{showDescansoButton({readonly,openDate:date,today:chicagoYmd(new Date()),superseded:Boolean(shift.supersededAt),laterShiftOfPerson:day.shifts.some(s=>s.employee.id===shift.employee.id&&s.id!==shift.id&&Date.parse(s.startAt)<Date.parse(shift.startAt))})&&<button type="button" className="block min-h-11" disabled={busy} onClick={()=>setBreakTarget({employeeId:shift.employee.id,name:displayName(shift)})}>BREAK</button>}<OverlayMenu day={day} shift={shift} board={board} date={date} locale={locale} managerToken={managerToken} readonly={readonly} busy={busy} onSaved={onSaved}/></th>{hourGridHours().map(h=>{
        const refusal=hourEditRefusal(publicDay,shift.id,h),pending=intents.filter(i=>i.intent.shiftId===shift.id&&Number(i.intent.quarter.slice(0,2))===h);
        return <td key={h} className="border p-0.5"><button type="button" className="w-full min-w-36" disabled={busy||readonly||!ready||unretained||cleanupPending||!choice||refusal==="SOURCE_NOT_AVAILABLE"} onClick={()=>refusal?setFeedback(explanation(refusal,es)):void stage(shift.id,h)} data-testid={`quarter-cell-${shift.id}-${h}`} aria-label={`${displayName(shift)} ${formatCompactHour(h)}`}><SavedShiftHour day={day} shiftId={shift.id} hour={h} locale={locale}/></button>{pending.length>0&&<span className="block border border-dashed border-blue-800 p-1" data-testid="quarter-private-preview">{es?"Privado":"Private"}: {pending.map(i=>`${i.intent.quarter} ${i.intent.action==="station"?day.stations.find(s=>s.id===(i.intent.action==="station"?i.intent.stationId:null))?.label:i.intent.action==="family"?i.intent.family:es?"Borrar":"Erase"}`).join(" · ")}</span>}</td>;
      })}</tr>)}<SavedCoverRows day={day} locale={locale} hours={hourGridHours()}/></tbody></table></div><SavedCoverPanel day={day} locale={locale} rows={false}/>
    {breakTarget&&<ManagerBreakDialog employeeId={breakTarget.employeeId} name={breakTarget.name} board={board} locale={locale} managerToken={managerToken} onClose={()=>setBreakTarget(null)} onSaved={onSaved}/>}
  </section>;
}
