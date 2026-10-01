"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { RECEIPT_DEVICES, ROLES, OBSERVATIONS, id, parseResponseFor, type Command, type Data, type Defaults, type Document, type Op, type Response, type Review, type Role, type Status } from "@/lib/receipts/protocol";
import { receiptTransport, requestId, type ReceiptTransport } from "@/lib/receipts/client";
import { documentText, OBSERVATION_COPY, printerName, priorObservationDetails, statusText, words, type ReceiptLocale } from "./copy";

export type ReceiptDocumentChoice = { document_handle: string; role: Role };
type Entry = { request_id: string; op: Op };
type Journal = { pending: Entry | null; entries: Entry[] };
type HistoryGroup = { key: string; request_id: string; plan_handle: string; state: Response["state"]; reason: Response["reason"]; documents: Document[]; suppressedContinuations: string[] };
const MUTATIONS = new Set<Op>(["prepare", "prepare_test", "re_review", "submit", "observe", "save_defaults"]);
const BUTTON = "min-h-14 rounded-lg border-2 border-neutral-900 bg-white px-4 py-2 text-xl font-bold text-neutral-950 disabled:opacity-40 active:bg-neutral-200";
const BOX = "rounded-xl border-2 border-neutral-400 bg-white p-4";
const EMPTY_ROUTES: Defaults["routes"] = { packing: null, CALIENTE: null, FRIO: null, EQUIPO: null, GERENTE: null };

function readJournal(key: string): Journal {
  const raw = sessionStorage.getItem(key);
  if (raw === null) return { pending: null, entries: [] };
  const value = JSON.parse(raw) as Journal;
  const valid = (entry: Entry) => entry && id.safeParse(entry.request_id).success && MUTATIONS.has(entry.op);
  if (!value || !Array.isArray(value.entries) || !value.entries.every(valid) || (value.pending !== null && !valid(value.pending))) throw new Error("journal");
  return value;
}

function command<K extends Op>(op: K, args: Extract<Command, { op: K }>["args"]): Command {
  return { schema: "receipt-browser/v1", request_id: requestId(), op, args } as Command;
}

export function ReceiptWorkspace({ manager, documents = [], locale = "es", onLock, transport = receiptTransport, devices = RECEIPT_DEVICES }: {
  manager: { id: string; token: string };
  documents?: ReceiptDocumentChoice[];
  locale?: ReceiptLocale;
  onLock: () => void;
  transport?: ReceiptTransport;
  devices?: readonly string[];
}) {
  const t = (es: string, en: string) => words(locale, es, en);
  const key = "receipt-journal-v1:" + manager.id;
  const alive = useRef(true);
  const running = useRef(false);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [statuses, setStatuses] = useState<Record<string, Status>>({});
  const [defaults, setDefaults] = useState<Defaults | null>(null);
  const [savedRoutes, setSavedRoutes] = useState<Defaults["routes"]>(EMPTY_ROUTES);
  const [saveReview, setSaveReview] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [destinations, setDestinations] = useState<Record<string, string>>({});
  const [review, setReview] = useState<Review | null>(null);
  const [groups, setGroups] = useState<HistoryGroup[]>([]);
  const history = groups.flatMap((group) => group.documents);
  const [reason, setReason] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingMessage, setPendingMessage] = useState<{ requestId: string; text: string } | null>(null);
  const [journal, setJournal] = useState<Journal>(() => {
    try { return readJournal(key); } catch { return { pending: null, entries: [] }; }
  });
  const [storageUnavailable, setStorageUnavailable] = useState(false);
  const journalRef = useRef(journal);
  useEffect(() => {
    alive.current = true;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => { alive.current = false; clearInterval(interval); };
  }, []);

  const persist = useCallback((value: Journal) => {
    sessionStorage.setItem(key, JSON.stringify(value));
    journalRef.current = value; setJournal(value);
  }, [key]);

  function accept(op: Op, data: Data | null, requestId: string, state: Response["state"], resultReason: Response["reason"], selectedGroup?: string): boolean {
    if (!data) return true;
    if ("review_handle" in data) {
      setReview(data);
      if (op === "re_review" && state === "ok") {
        // A validated successor review makes the older membership's controls
        // stale. Keep its received facts/actions intact; this mask only hides
        // local controls and survives a later replay of that same old group.
        setGroups((old) => old.map((group) => ({ ...group, suppressedContinuations: [...new Set([
          ...group.suppressedContinuations,
          ...group.documents.filter((row) => row.state === "not_attempted" && row.allowed_actions.includes("review_pending") && group.plan_handle !== data.plan_handle && data.documents.some((next) =>
            next.reservation_handle === row.reservation_handle && next.document_handle === row.document_handle && next.role === row.role && next.reservation_revision >= row.reservation_revision
          )).map((row) => row.reservation_handle),
        ])] })));
      }
    }
    else if ("plan_handle" in data) {
      const key = requestId + ":" + data.plan_handle;
      const group: HistoryGroup = { key, request_id: requestId, plan_handle: data.plan_handle, state, reason: resultReason, documents: data.documents, suppressedContinuations: [] };
      setGroups((old) => { const index = old.findIndex((g) => g.key === key); return index < 0 ? [...old, group] : old.map((g, i) => i === index ? { ...group, suppressedContinuations: g.suppressedContinuations } : g); });
      setReview(null);
    } else if ("attempt" in data) {
      // Observe names only A. Retain the selected claimed membership locally;
      // never broadcast it into historical batches that happen to share A.
      const group = groups.find((g) => g.key === selectedGroup);
      const row = group?.documents.find((d) => d.attempt_id === data.attempt.attempt_id && ["transmitted", "uncertain"].includes(d.state));
      if (!row || row.reservation_handle !== data.attempt.reservation_handle || row.document_handle !== data.attempt.document_handle || row.device_id !== data.attempt.device_id || row.role !== data.attempt.role || row.parent_attempt_id !== data.attempt.parent_attempt_id || row.state !== data.attempt.state) return false;
      setGroups((old) => old.map((g) => g.key === selectedGroup ? { ...g, documents: g.documents.map((d) => d.reservation_handle === row.reservation_handle ? data.attempt : d) } : g));
    } else if ("routes" in data) { setDefaults(data); setSavedRoutes(data.routes); if (defaults && defaults.revision !== data.revision) setReview(null); if (op === "save_defaults") { setReview(null); setSaveReview(false); } }
    else if ("device_id" in data) setStatuses((old) => ({ ...old, [data.device_id]: data }));
    return true;
  }
  function responseNotice(result: Response): string | null {
    if (["status_cached", "status_refresh"].includes(result.op ?? "") && result.state !== "ok") return t("No se pudo completar la consulta. No tenemos un estado actual de la impresora.", "The check could not complete. Current printer status is unavailable.");
    if (result.reason === "revision_conflict") return t("Los destinos predeterminados cambiaron desde que abriste esta pantalla. No se guardaron tus cambios. Carga los actuales y revísalos antes de guardar.", "Defaults changed. Your changes were not saved. Load the current destinations and review them before saving.");
    if (result.reason === "stale_plan") return t("El pedido, los destinos o la selección cambiaron. Revisa una nueva vista previa antes de enviar.", "The order, destinations or selection changed. Review a new preview before sending.");
    if (result.op === "submit" && result.state === "pending") return t("Envío en curso. Revisa este intento; no se reenviará automáticamente.", "Send in progress. Review this attempt; it will not resend automatically.");
    if (result.reason === "result_unconfirmed") return t("Puede haber salido papel. El estado actual no está confirmado. Revisa este intento; no se reenviará automáticamente.", "Paper may have printed. The current state is unconfirmed. Review this attempt; it will not resend automatically.");
    if (result.state === "unavailable") return t("No se pudo leer el registro. No podemos confirmar los envíos anteriores en este momento. Revisa este intento cuando el registro vuelva a estar disponible, antes de preparar otra copia.", "Could not read the record. We cannot confirm previous sends. Review this attempt when history is available before preparing another copy.");
    if (result.op === "submit" && result.state === "refused") return t("Este envío se detuvo. Revisa el resultado registrado de cada boleto.", "This send stopped. Review each ticket's recorded result.");
    if (result.state === "refused") return t("No se pudo preparar esta acción. Revisa el contenido, el destino y el acceso antes de continuar.", "This action could not be prepared. Check content, destination and access before continuing.");
    return null;
  }
  function pendingNotice(requestId: string, text: string | null) {
    // Reading an older send cannot replace the notice for a different pending one.
    if (journalRef.current.pending && journalRef.current.pending.request_id !== requestId) return;
    setPendingMessage(text ? { requestId, text } : null);
  }
  async function issue(request: Command, selectedGroup?: string) {
    if (running.current || !alive.current) return;
    const mutation = MUTATIONS.has(request.op);
    if (mutation && (journalRef.current.pending || storageUnavailable)) return;
    running.current = true; setBusy(true); setNotice(null);
    try {
      if (mutation) {
        try {
          // Re-read before a mutation so inaccessible/corrupt history cannot be
          // replaced with an empty success. Only request IDs/ops are persisted.
          const prior = readJournal(key);
          if (prior.pending) { setJournal(prior); journalRef.current = prior; return; }
          const entry = { request_id: request.request_id, op: request.op };
          persist({ pending: entry, entries: [...prior.entries, entry] });
        } catch { setStorageUnavailable(true); setNotice(t("No se pudo leer el registro. No se solicitó el envío.", "History is unavailable. No send was requested.")); return; }
      }
      const result = parseResponseFor(request, await transport(request, manager.token), devices);
      if (!alive.current) return;
      if (result.request_id !== request.request_id || result.op !== request.op) throw new Error("correlation");
      if (result.reason === "unauthorized") { onLock(); return; }
      if (request.op === "recover" && (result.state === "unavailable" || result.state === "pending")) holdRecovery(request.args.original_request_id);
      if ((request.op === "status_cached" || request.op === "status_refresh") && result.data === null) invalidateStatus(request.args.device_id);
      if (request.op === "recover" && result.data && "original_request_id" in result.data) {
        if (result.data.original_request_id !== request.args.original_request_id) throw new Error("original ID");
        const recovered = result.data;
        const shown = accept(recovered.original_op, recovered.original_data, recovered.original_request_id, recovered.original_state, recovered.original_reason);
        const unresolved = recovered.original_state === "unavailable" || recovered.original_state === "pending";
        if (unresolved) holdRecovery(recovered.original_request_id);
        if (!unresolved && journalRef.current.pending?.request_id === recovered.original_request_id) persist({ ...journalRef.current, pending: null });
        const message = responseNotice({ ...result, op: recovered.original_op, state: recovered.original_state, reason: recovered.original_reason, data: recovered.original_data });
        setNotice(shown ? message : t("Revisa el registro del envío para ver esta observación en su contexto.", "Review the send record to see this observation in context."));
        if (recovered.original_op === "submit") pendingNotice(recovered.original_request_id, message);
      } else {
        const shown = !result.data || "original_request_id" in result.data || accept(request.op, result.data, request.request_id, result.state, result.reason, selectedGroup);
        if (mutation && result.state !== "unavailable" && result.state !== "pending") persist({ ...journalRef.current, pending: null });
        const message = responseNotice(result);
        setNotice(shown ? message : t("Revisa el registro del envío para ver esta observación en su contexto.", "Review the send record to see this observation in context."));
        if (request.op === "submit" || request.op === "recover") pendingNotice(request.op === "recover" ? request.args.original_request_id : request.request_id, message);
      }
    } catch {
      if (alive.current) {
        if (request.op === "submit" || request.op === "recover") pendingNotice(request.op === "recover" ? request.args.original_request_id : request.request_id, null);
        if (request.op === "recover") holdRecovery(request.args.original_request_id);
        if (request.op === "status_refresh" || request.op === "status_cached") {
          invalidateStatus(request.args.device_id);
          setNotice(t("No se pudo actualizar el estado. Se conserva la hora de la última respuesta válida.", "Status could not be updated. The last valid response time is retained."));
        } else setNotice(t("No pudimos confirmar el resultado. Puede haber salido papel. Revisa la impresora y el registro del intento antes de decidir otra impresión.", "The result could not be confirmed. Paper may have printed. Check the printer and attempt history before deciding to print again."));
      }
    } finally { running.current = false; if (alive.current) setBusy(false); }
  }
  function holdRecovery(originalId: string) {
    const entry = journalRef.current.entries.find((e) => e.request_id === originalId);
    if (!entry || journalRef.current.pending) return;
    try { persist({ ...journalRef.current, pending: entry }); } catch { setStorageUnavailable(true); }
  }
  function invalidateStatus(device: string) {
    setStatuses((old) => old[device] ? { ...old, [device]: { ...old[device], condition: "unknown", display_code: "query_unavailable", last_outcome: "failed", reason: "query_unavailable" } } : old);
  }
  const blocked = busy || !!journal.pending || storageUnavailable;
  const recover = (entry: Entry) => void issue(command("recover", { original_request_id: entry.request_id }));
  const destination = (handle: string, fallback?: string) => destinations[handle] ?? fallback ?? "";
  const changeDestination = (handle: string, value: string) => { setDestinations((old) => ({ ...old, [handle]: value })); setReview(null); };
  const loadDefaults = () => void issue(command("read_defaults", {}));
  function prepare() {
    if (!defaults || history.length) return;
    void issue(command("prepare", { document_handles: selected, device_ids: selected.map((h) => destination(h)), action: "original", parent_attempt_ids: selected.map(() => null), observation_ids: selected.map(() => null), expected_defaults_revision: defaults.revision, reason: "" }));
  }
  function child(row: Document, action: "retry" | "cambio") {
    if (!defaults || !row.attempt_id || !row.allowed_actions.includes(action)) return;
    void issue(command("prepare", { document_handles: [row.document_handle], device_ids: [destination(row.reservation_handle, row.device_id)], action, parent_attempt_ids: [row.attempt_id], observation_ids: [row.observation_id], expected_defaults_revision: defaults.revision, reason }));
  }
  function reReview(rows: Pick<Document, "reservation_handle" | "reservation_revision" | "device_id">[]) {
    if (!defaults) return;
    void issue(command("re_review", { reservation_handles: rows.map((r) => r.reservation_handle), expected_reservation_revisions: rows.map((r) => r.reservation_revision), device_ids: rows.map((r) => destination(r.reservation_handle, r.device_id)), expected_defaults_revision: defaults.revision, reason }));
  }
  const printerSelect = (value: string, onChange: (value: string) => void, label: string) => (
    <select className="min-h-14 rounded border-2 border-neutral-700 bg-white p-2" aria-label={label} value={value} disabled={blocked} onChange={(e) => onChange(e.target.value)}>
      <option value="">{t("Elegir impresora…", "Choose printer…")}</option>
      {devices.map((device) => <option key={device} value={device}>{printerName(device)}</option>)}
    </select>
  );

  return <section className="flex flex-col gap-5 text-neutral-950" data-testid="receipt-workspace">
    {notice && <p role="alert" className="rounded-lg border-2 border-amber-800 bg-amber-50 p-4">{notice}</p>}
    {journal.pending && <div className={BOX} role="status">
      <p>{pendingMessage?.requestId === journal.pending.request_id ? pendingMessage.text : t("Puede haber salido papel. El intento anterior sigue pendiente de revisión. No se reenviará automáticamente.", "Paper may have printed. The previous attempt still needs review. It will not be resent automatically.")}</p>
      <button className={BUTTON} disabled={busy} onClick={() => recover(journal.pending!)}>{t("Revisar este intento", "Review this attempt")}</button>
    </div>}

    <section className={BOX} aria-label={t("Boletos de cocina", "Kitchen tickets")}>
      <h2 className="text-2xl font-black">{t("Boletos de cocina", "Kitchen tickets")}</h2>
      <p>{t("Selecciona los boletos y una impresora para cada uno. Se conserva el contenido del pedido.", "Select tickets and one printer for each. Order content stays unchanged.")}</p>
      {!documents.length && <p role="status">{t("El contenido de este boleto necesita revisión. No está listo para enviarse.", "Ticket content needs review. It is not ready to send.")}</p>}
      {documents.map((doc) => <div key={doc.document_handle} className="my-3 flex flex-wrap items-center gap-4">
        <label><input className="mr-3 size-6" type="checkbox" disabled={blocked || !!history.length || (!selected.includes(doc.document_handle) && selected.length >= 4)} checked={selected.includes(doc.document_handle)} onChange={(e) => { setSelected((old) => e.target.checked ? [...old, doc.document_handle] : old.filter((h) => h !== doc.document_handle)); setReview(null); }} />{doc.role === "FRIO" ? "FRÍO" : doc.role}</label>
        {printerSelect(destination(doc.document_handle), (value) => changeDestination(doc.document_handle, value), t("Destino del boleto ", "Ticket destination ") + doc.role)}
        <span>{t("Una copia por boleto seleccionado.", "One copy per selected ticket.")}</span>
      </div>)}
      <div className="my-3 flex flex-wrap gap-3">
        <button className={BUTTON} disabled={busy} onClick={loadDefaults}>{t("Cargar destinos actuales", "Load current destinations")}</button>
        <button className={BUTTON} disabled={blocked || !defaults} onClick={() => { setDestinations((old) => ({ ...old, ...Object.fromEntries(documents.map((d) => [d.document_handle, defaults!.routes[d.role] ?? ""])) })); setReview(null); }}>{t("Usar destinos predeterminados", "Use default destinations")}</button>
        <button className={BUTTON} disabled={blocked || !defaults || !selected.length || !!history.length || selected.some((h) => !destination(h))} onClick={prepare}>{t("Revisar boletos y destinos", "Review tickets and destinations")}</button>
      </div>
      <p>{t("Este cambio se aplica solo a este pedido. Guardar destinos predeterminados es una acción aparte.", "These choices apply only to this order. Saving default destinations is a separate action.")}</p>
    </section>

    <details className={BOX}>
      <summary className="cursor-pointer text-xl font-bold">{t("Destinos predeterminados", "Default destinations")}</summary>
      <p>{t("No envía boletos ni cambia un envío que ya comenzó.", "This does not send tickets or change a send already started.")}</p>
      {ROLES.map((r) => <label key={r} className="my-2 flex flex-wrap items-center gap-4">{r}{printerSelect(savedRoutes[r] ?? "", (value) => { setSavedRoutes((old) => ({ ...old, [r]: value || null })); setSaveReview(false); }, t("Predeterminado ", "Default ") + r)}</label>)}
      {!saveReview ? <button className={BUTTON} disabled={blocked || !defaults} onClick={() => setSaveReview(true)}>{t("Guardar destinos predeterminados", "Save default destinations")}</button> : <div>
        <h3 className="font-bold">{t("Guardar estos destinos para próximos envíos", "Save these destinations for future sends")}</h3>
        <ul>{ROLES.map((r) => <li key={r}>{r} → {savedRoutes[r] ? printerName(savedRoutes[r]) : "—"}</li>)}</ul>
        <button className={BUTTON} disabled={blocked || !defaults} onClick={() => void issue(command("save_defaults", { expected_revision: defaults!.revision, routes: savedRoutes, reason: "" }))}>{t("Confirmar destinos", "Confirm destinations")}</button>
        <button className={BUTTON} onClick={() => setSaveReview(false)}>{t("Cancelar", "Cancel")}</button>
      </div>}
    </details>

    {review && <section className={BOX} aria-label={t("Revisa antes de imprimir", "Review before printing")}>
      <h2 className="text-2xl font-black">{t("Revisa antes de imprimir", "Review before printing")}</h2>
      {review.mode !== "order" && <p className="font-bold">{t("1 boleto de prueba. No es un pedido y no cambia los destinos guardados.", "One test ticket. This is not an order and does not change saved destinations.")}</p>}
      {review.documents.map((doc) => <article className="my-4 border-b-2 pb-3" key={doc.reservation_handle}>
        <h3 className="font-bold">1 {doc.action === "cambio" ? "CAMBIO · " : ""}{doc.role} → {printerName(doc.device_id)}</h3>
        {doc.parent_attempt_id && <p>{t("Ligado al intento anterior; puede salir una copia adicional.", "Linked to the previous attempt; an additional copy may print.")}</p>}
        <pre className="overflow-auto whitespace-pre-wrap break-words rounded bg-neutral-100 p-3 text-xl">{doc.preview_lines.join("\n")}</pre>
      </article>)}
      <p>{review.total_documents} {t("boletos en total.", "tickets total.")}</p>
      <ul>{review.totals.map((v) => <li key={v.device_id}>{printerName(v.device_id)}: {v.count}</li>)}</ul>
      {(!review.submit_allowed || Date.parse(review.expires_at) <= now) && <p role="status">{Date.parse(review.expires_at) <= now ? t("Revisión vencida. Revisa una nueva vista previa antes de enviar.", "Review expired. Review a new preview before sending.") : t("El envío todavía no está habilitado.", "Sending is not enabled yet.")}</p>}
      <div className="mt-3 flex flex-wrap gap-3">
        <button className={BUTTON} disabled={blocked || !review.submit_allowed || Date.parse(review.expires_at) <= now} onClick={() => void issue(command("submit", { review_handle: review.review_handle }))}>{review.mode === "order" ? t(`Imprimir ${review.total_documents} boleto${review.total_documents === 1 ? "" : "s"}`, `Print ${review.total_documents} ticket${review.total_documents === 1 ? "" : "s"}`) : t("Enviar 1 boleto de prueba", "Send 1 test ticket")}</button>
        <button className={BUTTON} disabled={blocked || !defaults} onClick={() => reReview(review.documents)}>{t("Revisar de nuevo", "Review again")}</button>
        <button className={BUTTON} disabled={busy} onClick={() => setReview(null)}>{t("Cancelar", "Cancel")}</button>
      </div>
    </section>}

    {history.length > 0 && <section className={BOX} aria-label={t("Resultado de cada envío", "Each send result")}>
      <h2 className="text-2xl font-black">{t("Resultado de cada envío", "Each send result")}</h2>
      <p>{t("Revisa el resultado de cada boleto. Algunos pueden haber salido. No repitas el pedido completo para resolver un solo boleto pendiente.", "Review each ticket result. Some may have printed. Do not repeat the whole order to resolve one pending ticket.")}</p>
      <label className="my-3 block">{t("Motivo de la copia CAMBIO", "Reason for CAMBIO copy")}<input className="ml-3 border-2 p-2" value={reason} maxLength={160} onChange={(e) => setReason(e.target.value)} /></label>
      {groups.map((group, groupIndex) => {
        // Positive execution belongs to the latest successful read notice,
        // not the retained row history after a later read loses that proof.
        const message = group.state === "pending" ? null : responseNotice({ schema: "receipt-public/v1", request_id: group.request_id, op: "submit", state: group.state, reason: group.reason, data: { plan_handle: group.plan_handle, documents: group.documents, total_documents: group.documents.length } });
        return <section key={group.key} data-testid="receipt-history-group" className="my-4 rounded-lg border-2 border-neutral-600 p-3">
        <h3 className="text-xl font-bold">{t("Resultado de este envío", "Result of this send")} · {groupIndex + 1}</h3>
        {message && <p data-testid="receipt-group-outcome">{message}</p>}
        {group.documents.map((row) => {
        const actions = group.suppressedContinuations.includes(row.reservation_handle) ? [] : row.allowed_actions;
        return <article data-testid="receipt-history-row" key={row.reservation_handle} className="my-4 rounded-lg border-2 border-neutral-300 p-3">
        <h3 className="font-bold">{row.role} → {printerName(row.device_id)}</h3>
        <p>{t("Último estado registrado: ", "Last recorded state: ")}{row.state === "not_attempted" ? t("No se intentó enviar en este envío", "No send was attempted in this send") : documentText(row.state, locale)}</p>
        <p>{t("Fecha del resultado de este envío: ", "Result time for this send: ")}<time dateTime={row.last_event_at}>{new Date(row.last_event_at).toLocaleString(locale, { timeZone: "America/Chicago" })}</time></p>
        {(row.state === "uncertain" || row.state === "transmitted" || row.observation === "not_seen") && <p>{t("Puede haber salido papel. Cambiar de impresora puede producir una copia duplicada. No se reenviará automáticamente.", "Paper may have printed. Changing printers can produce a duplicate. Nothing will be resent automatically.")}</p>}
        {row.observation && <p>{OBSERVATION_COPY[row.observation][locale === "es" ? 0 : 1]}</p>}
        {actions.includes("observe") && row.attempt_id && <fieldset disabled={blocked} className="my-2 flex flex-wrap gap-2"><legend>{t("Registrar lo que salió", "Record what printed")}</legend>{OBSERVATIONS.map((o) => <button key={o} className={BUTTON} onClick={() => void issue(command("observe", { attempt_id: row.attempt_id!, observation: o, evidence_handle: null }), group.key)}>{OBSERVATION_COPY[o][locale === "es" ? 0 : 1]}</button>)}</fieldset>}
        {actions.some((a) => ["retry", "cambio", "review_pending"].includes(a)) && printerSelect(destination(row.reservation_handle, row.device_id), (v) => changeDestination(row.reservation_handle, v), t("Destino siguiente ", "Next destination ") + row.role)}
        {actions.includes("retry") && <button className={BUTTON} disabled={blocked || !defaults || !destination(row.reservation_handle, row.device_id)} onClick={() => child(row, "retry")}>{t("Reintentar este boleto", "Retry this ticket")}</button>}
        {actions.includes("cambio") && row.observation && row.observation !== "pending" && <button className={BUTTON} disabled={blocked || !defaults || !reason.trim() || !destination(row.reservation_handle, row.device_id)} onClick={() => child(row, "cambio")}>{t("Preparar copia CAMBIO", "Prepare CAMBIO copy")}</button>}
        {actions.includes("review_pending") && <button className={BUTTON} disabled={blocked || !defaults || !destination(row.reservation_handle, row.device_id)} onClick={() => reReview([row])}>{t("Revisar boletos pendientes", "Review pending tickets")}</button>}
      </article>;
      })}
      </section>;
      })}
    </section>}

    <section className={BOX} aria-label={t("Impresoras de recibos", "Receipt printers")}>
      <h2 className="text-2xl font-black">{t("Impresoras de recibos", "Receipt printers")}</h2>
      <p>{t("Consultar el estado no imprime boletos. Abrir esta pantalla no envía una prueba.", "Checking status does not print tickets. Opening this screen does not send a test.")}</p>
      <div className="grid gap-4 lg:grid-cols-2">{devices.map((device) => {
        const status = statuses[device];
        return <article key={device} className="my-3 rounded-lg border-2 border-neutral-300 p-3">
          <h3 className="text-xl font-bold">{printerName(device)}</h3>
          <p className="font-bold">{statusText(status, locale, now)}</p>
          <p>{status?.commissioned_for_orders ? t("Habilitada para pedidos; revisa cada envío en papel.", "Commissioned for orders; check paper after every send.") : t("Pendiente de prueba en papel", "Paper commissioning pending")}</p>
          <p>{t("Última consulta: ", "Last request: ")}{status?.last_request_at ? new Date(status.last_request_at).toLocaleString(locale, { timeZone: "America/Chicago" }) : "—"}</p>
          <p>{t("Última respuesta válida: ", "Last valid response: ")}{status?.last_valid ? new Date(status.last_valid.observed_at).toLocaleString(locale, { timeZone: "America/Chicago" }) : t("Sin respuesta válida registrada.", "No valid response recorded.")}</p>
          {status?.last_valid && <aside className="my-3 rounded border-2 border-dashed border-neutral-500 bg-neutral-100 p-3" aria-label={t("Último estado conocido", "Last known status")}>
            <p className="font-bold">{t("Último estado conocido: ", "Last known status: ")}{status.last_valid.condition === "blocked" ? t("Con avisos", "With faults") : t("Sin bloqueo informado", "No blocking fault reported")}</p>
            <ul>{priorObservationDetails(status.last_valid, locale).map((detail) => <li key={detail}>{detail}</li>)}</ul>
            <p>{t("Respuesta del ", "Response from ")}<time dateTime={status.last_valid.observed_at}>{new Date(status.last_valid.observed_at).toLocaleString(locale, { timeZone: "America/Chicago" })}</time></p>
            <p>{t("Validez de esa respuesta hasta ", "That response valid until ")}<time dateTime={status.last_valid.expires_at}>{new Date(status.last_valid.expires_at).toLocaleString(locale, { timeZone: "America/Chicago" })}</time></p>
            <p>{t("Este dato anterior no confirma cómo está ahora.", "This prior observation does not confirm its current condition.")}</p>
          </aside>}
          {status?.last_valid && ["failed", "busy", "throttled"].includes(status.last_outcome) && <p>{t("Se conserva la hora de la última respuesta válida. La consulta no se repetirá automáticamente.", "The last valid response time is retained. This check will not repeat automatically.")}</p>}
          <div className="mt-3 flex flex-wrap gap-2">
            <button className={BUTTON} disabled={busy} onClick={() => void issue(command("status_cached", { device_id: device }))}>{t("Ver registro", "View saved status")}</button>
            <button className={BUTTON} disabled={busy} onClick={() => void issue(command("status_refresh", { device_id: device }))}>{t("Consultar estado", "Check status")}</button>
            <button className={BUTTON} disabled={blocked || !status} onClick={() => void issue(command("prepare_test", { device_id: device, mode: "manager_test", expected_registry_revision: status!.registry_revision }))}>{t("Preparar prueba", "Prepare test")}</button>
          </div>
        </article>;
      })}</div>
    </section>
    {journal.entries.length > 0 && <details className={BOX}><summary className="text-xl font-bold">{t("Intentos recientes", "Recent attempts")}</summary><p>{t("Revisar el registro no envía otro boleto.", "Reviewing history does not send another ticket.")}</p>{journal.entries.map((entry, index) => <button key={entry.request_id} className={BUTTON} disabled={busy} onClick={() => recover(entry)}>{t("Revisar registro ", "Review record ")}{index + 1}</button>)}</details>}
  </section>;
}
