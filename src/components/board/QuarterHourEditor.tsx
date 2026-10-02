"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { showDescansoButton } from "@/lib/breaks/picker-steps";
import { chicagoYmd } from "@/lib/schedule/build-schedule";
import { paletteSlots,PAINT_FAMILY_LABELS } from "@/lib/assignments/paint-families";
import { activeGeneration, conflictBranches, DraftDatabase } from "@/lib/quarter/client/draft-db";
import { generation,newEnvelope,type DraftGeneration,type DraftScope,type DraftSnapshot } from "@/lib/quarter/client/draft-types";
import { proposeHours, proposeQuarters } from "@/lib/quarter/client/edit";
import { QuarterGrid, type GridCell, type GridNotice } from "./QuarterGrid";
import { capabilities, matchCapabilities, sendSubmission } from "@/lib/quarter/client/transport";
import { observeV1,v1Key } from "@/lib/quarter/client/v1-conversion";
import { canonicalJson } from "@/lib/quarter/client/primitives";
import { ManagerBreakDialog } from "@/components/breaks/ManagerBreakDialog";
import { OverlayMenu } from "./OverlayMenu";
import { SavedCoverPanel } from "./SavedCoverDisplay";
import { displayName,stationColorClass } from "./board-helpers";
import type { ColorEditorProps } from "./ManagerColorEditor";
const empty:DraftSnapshot={head:null,generations:[],submissions:[],archives:[],originals:[],warnings:[]};
function reviewText(value:unknown):string {
  const seen=new WeakSet<object>();
  try{return JSON.stringify(value,(_key,v)=>{
    if(typeof v==="bigint")return `${v} (BigInt)`;
    if(v&&typeof v==="object"){if(seen.has(v))return "[circular reference; original retained]";seen.add(v);}
    return v;
  },2)??String(value);}catch{return "Original retained; this value cannot be displayed.";}
}
function originalText(value:unknown):string|null {
  if(!value||typeof value!=="object")return null;
  const row=value as Record<string,unknown>;
  return typeof row.requestBytes==="string"?row.requestBytes:typeof row.original==="string"?row.original:null;
}
/** Q1 extends R0 retention without changing its envelope, receipts or review-only paths. */
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
  const [legacyOriginal,setLegacyOriginal]=useState<string|null>(null);
  const [notice,setNotice]=useState<GridNotice|null>(null);
  const lastCell=useRef<GridCell|null>(null), attemptedCells=useRef<GridCell[]>([]);
  const [choice,setChoice]=useState<string|null>(null),[breakTarget,setBreakTarget]=useState<{employeeId:string;name:string}|null>(null);
  const current=activeGeneration(snapshot),branches=conflictBranches(snapshot),intents=(current?.envelope.intents??[]).filter(i=>!confirmedIntentIds.includes(i.intentId));
  const refresh=useCallback(async()=>{
    if(!db.current)return;
    const scope={managerId,board,date},before=await db.current.read(scope);
    setSnapshot(before);setReady(!db.current.readOnly&&!before.warnings.length);
    try{setLegacyOriginal(localStorage.getItem(v1Key(scope)));}
    catch{setReady(false);setFeedback(es?"No se pudo leer el borrador anterior. Los datos retenidos siguen disponibles para revisión.":"The old draft could not be read. Retained data remains available for review.");return;}
    if(db.current.readOnly||before.warnings.length)return;
    const observed=latest.current?await observeV1(db.current,scope,latest.current):{changed:false,snapshot:before};
    setSnapshot(observed.snapshot);
    setReady(!observed.snapshot.warnings.length);
    if(observed.snapshot.warnings.length)return;
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
      if(!live){store.close();return;}connection=store;db.current=store;await refresh();
    }).catch(error=>{if(live)setFeedback(`${es?"No retenido":"Not retained"}: ${error.message}`);});
    const focus=()=>{if(!pendingMemory.current)void refresh().catch(error=>setFeedback(error.message));};
    window.addEventListener("focus",focus);
    return ()=>{live=false;window.removeEventListener("focus",focus);connection?.close();db.current=null;};
  },[refresh,es]);
  async function run(action:()=>Promise<unknown>){setBusy(true);try{await action();onDraftChange();}catch(error){const code=error instanceof Error?error.message:String(error);setFeedback(`${es?"No retenido / requiere revisión":"Not retained / review required"}: ${code}`);if(lastCell.current)setNotice({...lastCell.current,code,errors:attemptedCells.current.map(cell=>({...cell,code}))});}finally{setBusy(false);}}
  async function stage(cells:GridCell[]){
    if(!db.current||!publicDay||!choice||readonly||!ready||cleanupPending||pendingMemory.current)return;
    lastCell.current=cells.at(-1)??null;attemptedCells.current=cells;
    await run(async()=>{
      const cap=await capabilities();matchCapabilities(cap,publicDay);
      if(cells.some(c=>c.minute!==null)&&!cap.quarterUi)throw new Error("QUARTER_UI_UNAVAILABLE");
      const action=choice==="erase"?{action:"erase" as const}:choice.startsWith("family:")?{action:"family" as const,family:choice.slice(7)}:{action:"station" as const,stationId:choice};
      // The visible base remains the CAS expectation even if another tab has advanced.
      await db.current!.read(scope);
      const changes=cells.map(c=>({...c,action}));
      const {base,proposal}=cells[0].minute===null?proposeHours(scope,snapshot,publicDay,changes):proposeQuarters(scope,snapshot,publicDay,changes.map(c=>({...c,minute:c.minute!})));
      pendingMemory.current=proposal;setPendingPreview(proposal);setUnretained(true);
      const result=await db.current!.retain(scope,base,proposal);pendingMemory.current=null;setPendingPreview(null);setUnretained(false);setSnapshot(result.snapshot);
      setFeedback(result.status==="conflict"?(es?"Conflicto: ambas versiones están retenidas.":"Conflict: both versions are retained."):(es?"Retenido localmente; aún sin guardar.":"Locally retained; not yet saved."));
    });
  }
  async function save(){if(!db.current||!publicDay||readonly||!ready||pendingMemory.current)return;
    attemptedCells.current=intents.map(({intent})=>({shiftId:intent.shiftId,hour:Number(intent.quarter.slice(0,2)),minute:intent.granularity==="hour"?null:Number(intent.quarter.slice(3)) as 0|15|30|45})).filter((cell,index,all)=>all.findIndex(other=>other.shiftId===cell.shiftId&&other.hour===cell.hour&&other.minute===cell.minute)===index);
    lastCell.current=attemptedCells.current.at(-1)??lastCell.current;
    await run(async()=>{
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
    if(result.status==="rejected"&&lastCell.current)setNotice({...lastCell.current,code:result.code??"SAVE_REJECTED",errors:attemptedCells.current.map(cell=>({...cell,code:result.code??"SAVE_REJECTED"}))});
    if(result.receipt)await onSaved();
  });}
  async function resolveBranch(branch:DraftGeneration,useBranch:boolean){if(!db.current||!ready||readonly||!snapshot.head||snapshot.head.pendingRequestId)return;await run(async()=>{
    const selected=useBranch?branch:current;if(!selected)throw new Error("DRAFT_REQUIRES_REVIEW");
    const envelope=newEnvelope({...selected.envelope,parentGenerationId:snapshot.head!.generationId,parentRevision:snapshot.head!.localRevision,pendingRequestId:null});
    const result=await db.current!.retain(scope,snapshot.head!,generation(scope,envelope,[branch.generationId]));setSnapshot(result.snapshot);
    setFeedback(es?"Selección retenida; las versiones originales se conservan.":"Selection retained; original versions are preserved.");
  });}
  const reviewOnly=Boolean(snapshot.warnings.length||!publicDay);
  const preservedReview=reviewOnly?<div data-testid="quarter-retained-review" className="space-y-2 rounded border-2 border-amber-700 p-3">
    <p role="alert">{es?"Solo revisión. Los originales están conservados; no se harán cambios ni reintentos.":"Review only. Originals are preserved; changes and retries are disabled."}</p>
    {[...new Set(snapshot.warnings)].map(w=><p key={w}>{w}</p>)}
    {snapshot.originals.map((original,index)=><details key={`${original.store}:${index}`} data-testid="quarter-invalid-original"><summary>{es?"Original sin validar; solo revisión":"Unvalidated original; review only"}: {original.store} · {original.reason}</summary><pre className="overflow-auto text-xs">{reviewText(original.value)}</pre>{originalText(original.value)!==null&&<pre data-testid="quarter-original-bytes" className="overflow-auto text-xs">{originalText(original.value)}</pre>}</details>)}
    {snapshot.generations.map(g=><details key={g.generationId}><summary>{es?"Ver borrador retenido":"View retained draft"}: {g.generationId}</summary><pre className="overflow-auto text-xs">{canonicalJson(g.envelope)}</pre></details>)}
    {snapshot.submissions.map(s=><details key={s.requestId}><summary>{es?"Ver solicitud original":"View original request"}: {s.requestId}</summary><pre className="overflow-auto text-xs">{s.requestBytes}</pre></details>)}
    {snapshot.archives.map(a=><details key={a.v1Sha256}><summary>{es?"Ver archivo anterior":"View earlier archive"}</summary><pre className="overflow-auto text-xs">{a.original}</pre></details>)}
    {legacyOriginal!==null&&<details><summary>{es?"Ver borrador anterior sin convertir":"View unconverted old draft"}</summary><pre className="overflow-auto text-xs">{legacyOriginal}</pre></details>}
  </div>:null;
  if(!day||!publicDay)return <section data-testid="quarter-hour-editor"><p role="status">{es?"Borrador conservado; el tablero compatible no está disponible.":"Draft retained; compatible board unavailable."}</p><p>{feedback}</p>{preservedReview}</section>;
  return <section className="space-y-3" data-testid="quarter-hour-editor" tabIndex={-1} data-paint-navigation-blocked={busy||unretained?"1":"0"}>
    <p className="text-sm">{es?"Pinta una hora uniforme o abre los cuartos para editar 15 minutos. Los cambios son privados hasta guardar.":"Paint a uniform hour or open quarters to edit 15 minutes. Changes stay private until saved."}</p>
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
    {preservedReview}
    {intents.length>0&&<p>{intents.length} {es?"cambios privados retenidos":"retained private changes"}</p>}
    {branches.map(branch=><div key={branch.generationId} className="rounded border-2 border-amber-700 p-3"><p>{es?"Otra versión retenida":"Another retained version"}: {branch.envelope.intents.length} {es?"cambios":"changes"}</p><details><summary>{es?"Ver versión original":"View original version"}</summary><pre className="overflow-auto text-xs">{canonicalJson(branch.envelope)}</pre></details><button type="button" className="min-h-11 border p-2" disabled={readonly||!ready||busy||Boolean(snapshot.head?.pendingRequestId)} onClick={()=>void resolveBranch(branch,true)}>{es?"Elegir esta versión":"Choose this version"}</button><button type="button" className="min-h-11 border p-2" disabled={readonly||!ready||busy||Boolean(snapshot.head?.pendingRequestId)} onClick={()=>void resolveBranch(branch,false)}>{es?"Conservar versión actual":"Keep current version"}</button></div>)}
    {!reviewOnly&&snapshot.archives.filter(a=>a.result==="review").map(a=><details key={a.v1Sha256}><summary>{es?"Borrador anterior requiere revisión":"Earlier draft requires review"}: {a.staleReason}</summary><pre className="overflow-auto text-xs">{a.original}</pre></details>)}
    <QuarterGrid day={day} locale={locale} selectedHour={selectedHour} onSelectHour={onSelectHour}
      intents={intents} disabled={busy||readonly||!ready||unretained||cleanupPending} hasChoice={Boolean(choice)} onPaint={stage} notice={notice} onNotice={setNotice}
      personControls={shift=><>{showDescansoButton({readonly,openDate:date,today:chicagoYmd(new Date()),superseded:Boolean(shift.supersededAt),laterShiftOfPerson:day.shifts.some(s=>s.employee.id===shift.employee.id&&s.id!==shift.id&&Date.parse(s.startAt)<Date.parse(shift.startAt))})&&<button type="button" className="block min-h-11" disabled={busy} onClick={()=>setBreakTarget({employeeId:shift.employee.id,name:displayName(shift)})}>BREAK</button>}<OverlayMenu day={day} shift={shift} board={board} date={date} locale={locale} managerToken={managerToken} readonly={readonly} busy={busy} onSaved={onSaved}/></>}/>
    <SavedCoverPanel day={day} locale={locale} rows={false}/>

    {breakTarget&&<ManagerBreakDialog employeeId={breakTarget.employeeId} name={breakTarget.name} board={board} locale={locale} managerToken={managerToken} onClose={()=>setBreakTarget(null)} onSaved={onSaved}/>}
  </section>;
}
