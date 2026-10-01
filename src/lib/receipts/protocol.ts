import { z } from "zod";

// Frozen receipt V4. The registry is injected only by tests; production uses
// these nine canonical identities, never a caller-supplied address or alias.
export const RECEIPT_DEVICES = ["receipt-120", "receipt-129", "receipt-138", "receipt-151", "receipt-153", "receipt-160", "receipt-161", "receipt-169", "receipt-186"] as const;
export const ROLES = ["packing", "CALIENTE", "FRIO", "EQUIPO", "GERENTE"] as const;
export const OPS = ["prepare", "prepare_test", "read_review", "re_review", "submit", "recover", "observe", "read_defaults", "save_defaults", "status_cached", "status_refresh"] as const;
export const REASONS = ["invalid_request", "unsupported_version", "unsupported_action", "unauthorized", "gate_off", "uncommissioned", "stale_plan", "stale_source", "source_unavailable", "content_held", "encoding_unsupported", "profile_mismatch", "request_conflict", "revision_conflict", "duplicate_original", "invalid_parent", "observation_required", "device_busy", "history_unavailable", "unknown_request", "artifact_changed", "preview_too_large", "sequence_not_started", "rate_limited", "runtime_unavailable", "identity_mismatch", "identity_unavailable", "device_fault", "no_response", "query_unavailable", "result_unconfirmed", "internal_error"] as const;
export const OBSERVATIONS = ["accepted", "not_seen", "partial", "duplicate", "pending"] as const;
export const id = z.string().regex(/^[a-f0-9]{32}$/);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const time = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/).refine((v) => Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v);
const safeText = z.string().refine((v) => v.normalize("NFC") === v && !/[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(v));
const reasonText = safeText.refine((v) => [...v].length <= 160);
const line = safeText.refine((v) => [...v].length <= 512);
const reason = z.enum(REASONS).nullable();
const state = z.enum(["ok", "refused", "pending", "partial", "unavailable"]);
const role = z.enum(ROLES);
const action = z.enum(["original", "retry", "cambio", "updated", "void"]);
const observation = z.enum(OBSERVATIONS);
const unique = <T,>(xs: T[]) => new Set(xs).size === xs.length;
const ids = z.array(id).min(1).max(4).refine(unique);
const parents = z.array(id.nullable()).min(1).max(4);

export function schemas(devices: readonly string[] = RECEIPT_DEVICES) {
  const device = z.string().refine((v) => devices.includes(v));
  const routes = z.object({ packing: device.nullable(), CALIENTE: device.nullable(), FRIO: device.nullable(), EQUIPO: device.nullable(), GERENTE: device.nullable() }).strict();
  const args = {
    prepare: z.object({ document_handles: ids, device_ids: z.array(device).min(1).max(4), action, parent_attempt_ids: parents, observation_ids: parents, expected_defaults_revision: revision, reason: reasonText }).strict().refine((v) => [v.device_ids, v.parent_attempt_ids, v.observation_ids].every((xs) => xs.length === v.document_handles.length)),
    prepare_test: z.object({ device_id: device, mode: z.enum(["manager_test", "commissioning"]), expected_registry_revision: revision }).strict(),
    read_review: z.object({ review_handle: id }).strict(),
    re_review: z.object({ reservation_handles: ids, expected_reservation_revisions: z.array(revision).min(1).max(4), device_ids: z.array(device).min(1).max(4), expected_defaults_revision: revision, reason: reasonText }).strict().refine((v) => v.reservation_handles.length === v.device_ids.length && v.reservation_handles.length === v.expected_reservation_revisions.length),
    submit: z.object({ review_handle: id }).strict(),
    recover: z.object({ original_request_id: id }).strict(),
    observe: z.object({ attempt_id: id, observation, evidence_handle: id.nullable() }).strict(),
    read_defaults: z.object({}).strict(),
    save_defaults: z.object({ expected_revision: revision, routes, reason: reasonText }).strict(),
    status_cached: z.object({ device_id: device }).strict(),
    status_refresh: z.object({ device_id: device }).strict(),
  };
  const alternatives = OPS.map((op) => z.object({ schema: z.literal("receipt-browser/v1"), request_id: id, op: z.literal(op), args: args[op] }).strict());
  const command = z.discriminatedUnion("op", [alternatives[0], ...alternatives.slice(1)]);
  const document = z.object({ document_handle: id, reservation_handle: id, reservation_revision: revision, role, attempt_id: id.nullable(), parent_attempt_id: id.nullable(), device_id: device, state: z.enum(["prepared", "in_flight", "refused", "transmitted", "uncertain", "not_attempted"]), reason, observation: observation.nullable(), observation_id: id.nullable(), last_event_at: time, allowed_actions: z.array(z.enum(["review_pending", "retry", "observe", "cambio", "recover"])).max(5).refine(unique) }).strict();
  const reviewDocument = z.object({ document_handle: id, reservation_handle: id, reservation_revision: revision, role, device_id: device, copy_count: z.literal(1), preview_lines: z.array(line).max(1000), action, parent_attempt_id: id.nullable(), observation_id: id.nullable() }).strict();
  const review = z.object({ review_handle: id, plan_handle: id, mode: z.enum(["order", "manager_test", "commissioning"]), created_at: time, expires_at: time, expected_defaults_revision: revision, registry_revision: revision, documents: z.array(reviewDocument).min(1).max(4), totals: z.array(z.object({ device_id: device, count: z.number().int().min(1).max(4) }).strict()).min(1).max(4), total_documents: z.number().int().min(1).max(4), submit_allowed: z.boolean(), blocked_reason: reason }).strict();
  const batch = z.object({ plan_handle: id, documents: z.array(document).min(1).max(4), total_documents: z.number().int().min(1).max(4) }).strict();
  const defaults = z.object({ revision, routes }).strict();
  const observed = z.object({ observation_id: id, attempt: document }).strict();
  const status = z.object({ device_id: device, registry_revision: revision, profile_sha256: sha.nullable(), commissioned_for_orders: z.boolean(), last_request_at: time.nullable(), last_probe_at: time.nullable(), last_outcome: z.enum(["valid", "failed", "busy", "throttled", "never"]), reason, last_valid: z.object({ observed_at: time, expires_at: time, condition: z.enum(["ready", "blocked"]), identity_match: z.literal(true), problems: z.array(z.enum(["offline", "cover_open", "feed_button", "paper_end_stop", "error_occurred", "autocutter_error", "unrecoverable_error", "auto_recoverable_error", "paper_out"])).max(9).refine(unique), warnings: z.array(z.literal("paper_near_end")).max(1) }).strict().nullable(), condition: z.enum(["ready", "blocked", "unknown", "stale", "busy", "rate_limited"]), display_code: z.enum(["rate_limited", "busy", "identity_mismatch", "identity_unknown", "no_response", "query_unavailable", "stale", "unknown", "paper_out", "cover_open", "printer_fault", "paper_warning", "ready"]) }).strict();
  return { command, args, document, reviewDocument, review, batch, defaults, observed, status };
}

type PublicSchemas = ReturnType<typeof schemas>;
export type Op = typeof OPS[number];
export type Role = typeof ROLES[number];
export type Reason = typeof REASONS[number];
export type Observation = typeof OBSERVATIONS[number];
export type Command = { [K in Op]: { schema: "receipt-browser/v1"; request_id: string; op: K; args: z.infer<PublicSchemas["args"][K]> } }[Op];
export type Review = z.infer<PublicSchemas["review"]>;
export type Document = z.infer<PublicSchemas["document"]>;
export type Batch = z.infer<PublicSchemas["batch"]>;
export type Defaults = z.infer<PublicSchemas["defaults"]>;
export type Status = z.infer<PublicSchemas["status"]>;
export type Observed = z.infer<PublicSchemas["observed"]>;
export type Data = Review | Batch | Defaults | Status | Observed;
export type Recovery = { original_request_id: string; original_op: Op; original_state: Response["state"]; original_reason: Reason | null; original_data: Data | null };
export type Response = { schema: "receipt-public/v1"; request_id: string | null; op: Op | null; state: "ok" | "refused" | "pending" | "partial" | "unavailable"; reason: Reason | null; data: Data | Recovery | null };

/** Reject duplicate object keys before JSON.parse can discard them. */
export function parseJSON(text: string, maxBytes: number): unknown {
  if (new TextEncoder().encode(text).length > maxBytes) throw new Error("size");
  let i = 0;
  const ws = () => { while (/\s/.test(text[i] ?? "") && i < text.length) i++; };
  function string(): string {
    const start = i++;
    while (i < text.length) { const c = text[i++]; if (c === "\\") i++; else if (c === '"') return JSON.parse(text.slice(start, i)); }
    throw new Error("string");
  }
  function value(depth: number): void {
    if (depth > 32) throw new Error("depth");
    ws(); const c = text[i];
    if (c === '"') { string(); return; }
    if (c === "{" || c === "[") {
      i++; ws(); const end = c === "{" ? "}" : "]"; const keys = new Set<string>();
      if (text[i] === end) { i++; return; }
      while (i < text.length) {
        ws();
        if (c === "{") { if (text[i] !== '"') throw new Error("key"); const key = string(); if (keys.has(key)) throw new Error("duplicate"); keys.add(key); ws(); if (text[i++] !== ":") throw new Error("colon"); }
        value(depth + 1); ws(); if (text[i] === end) { i++; return; } if (text[i++] !== ",") throw new Error("comma");
      }
      throw new Error("end");
    }
    const m = /^(?:null|true|false|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(i));
    if (!m) throw new Error("value"); i += m[0].length;
    if (m[0] !== "null" && m[0] !== "true" && m[0] !== "false" && !Number.isFinite(Number(m[0]))) throw new Error("number");
  }
  value(0); ws(); if (i !== text.length) throw new Error("trailing"); return JSON.parse(text);
}

export function parseCommand(value: unknown, devices: readonly string[] = RECEIPT_DEVICES): Command {
  return schemas(devices).command.parse(value) as Command;
}

const envelope = z.object({ schema: z.literal("receipt-public/v1"), request_id: id.nullable(), op: z.enum(OPS).nullable(), state, reason, data: z.unknown() }).strict();

export function parseResponse(value: unknown, devices: readonly string[] = RECEIPT_DEVICES): Response {
  if (new TextEncoder().encode(JSON.stringify(value) + "\n").length > 65536) throw new Error("result size");
  const out = envelope.parse(value); const s = schemas(devices);
  function data(op: Op, raw: unknown, resultState: Response["state"], resultReason: Reason | null): Data {
    if (op !== "submit" && (!["ok", "refused", "unavailable"].includes(resultState) || (resultState === "ok") !== (resultReason === null))) throw new Error("data envelope");
    if (["prepare", "prepare_test", "read_review", "re_review"].includes(op)) {
      const r = s.review.parse(raw);
      const totals: { device_id: string; count: number }[] = [];
      for (const d of r.documents) { const total = totals.find((t) => t.device_id === d.device_id); if (total) total.count++; else totals.push({ device_id: d.device_id, count: 1 }); }
      if (r.total_documents !== r.documents.length || JSON.stringify(totals) !== JSON.stringify(r.totals) || !unique(r.documents.map((d) => d.reservation_handle)) || !unique(r.documents.map((d) => d.document_handle)) || !unique(r.documents.map((d) => d.role)) || Date.parse(r.expires_at) - Date.parse(r.created_at) !== 300_000 || (r.submit_allowed && r.blocked_reason !== null)) throw new Error("review");
      if (resultState !== "ok" && (r.submit_allowed || r.blocked_reason !== resultReason)) throw new Error("review envelope");
      return r;
    }
    const checkDocument = (d: Document, recoverOnly = false) => {
      const allowed: Record<Document["state"], string[]> = { prepared: ["review_pending"], not_attempted: ["review_pending"], refused: ["retry"], in_flight: ["recover"], transmitted: ["observe", "cambio"], uncertain: ["observe", "cambio"] };
      if (["in_flight", "refused", "transmitted", "uncertain"].includes(d.state) && d.attempt_id === null) throw new Error("attempt");
      if ((d.observation === null) !== (d.observation_id === null) || (d.observation !== null && (!d.attempt_id || !["transmitted", "uncertain"].includes(d.state)))) throw new Error("observation");
      if (["prepared", "in_flight", "transmitted"].includes(d.state) && d.reason !== null) throw new Error("row reason");
      if ((d.state === "uncertain" && d.reason !== "result_unconfirmed") || (d.state === "refused" && d.reason === null)) throw new Error("row reason");
      if (d.allowed_actions.some((a) => !(recoverOnly ? ["recover"] : allowed[d.state]).includes(a))) throw new Error("actions");
      if (d.allowed_actions.includes("cambio") && (!d.observation_id || !d.observation || d.observation === "pending")) throw new Error("observation");
    };
    if (op === "submit") {
      const b = s.batch.parse(raw), rows = b.documents;
      if (b.total_documents !== rows.length || !unique(rows.map((d) => d.reservation_handle)) || !unique(rows.map((d) => d.document_handle)) || !unique(rows.map((d) => d.role)) || !unique(rows.map((d) => d.attempt_id).filter((id) => id !== null))) throw new Error("batch identities");
      const unfinished = rows.some((d) => d.state === "prepared" || d.state === "in_flight");
      const historyUnavailable = resultState === "unavailable" && resultReason === "history_unavailable";
      const ownerUnconfirmed = unfinished && resultState === "unavailable" && resultReason === "result_unconfirmed";
      const pending = unfinished && resultState === "pending" && resultReason === null;
      if (unfinished && rows.some((d) => d.attempt_id === null)) throw new Error("accepted attempt");
      // The effective submit envelope constrains EVERY retained row. It does
      // not change row facts or prove acceptance/positive ownership itself.
      rows.forEach((d) => checkDocument(d, historyUnavailable || ownerUnconfirmed || pending));
      if (historyUnavailable || ownerUnconfirmed || pending) return b;
      if (unfinished || resultState === "unavailable") throw new Error("unfinished envelope");
      const stopping = rows.find((d) => d.reason !== null)?.reason ?? null;
      const stopped = rows.every((d) => d.state === "refused" || d.state === "not_attempted");
      const allSent = rows.every((d) => d.state === "transmitted");
      const expectedState = stopped ? "refused" : allSent ? "ok" : "partial";
      const expectedReason = stopped ? (rows.every((d) => d.state === "not_attempted") ? "sequence_not_started" : stopping)
        : allSent ? null : rows.some((d) => d.state === "uncertain") ? "result_unconfirmed" : stopping;
      if (resultState !== expectedState || resultReason !== expectedReason) throw new Error("aggregate");
      return b;
    }
    if (resultState !== "ok") throw new Error("read envelope");
    if (op === "observe") { const o = s.observed.parse(raw); checkDocument(o.attempt); if (o.observation_id !== o.attempt.observation_id) throw new Error("observation ID"); return o; }
    if (op === "read_defaults" || op === "save_defaults") return s.defaults.parse(raw);
    if (op === "status_cached" || op === "status_refresh") {
      const status = s.status.parse(raw);
      if (status.last_valid && Date.parse(status.last_valid.expires_at) - Date.parse(status.last_valid.observed_at) !== 60000) throw new Error("observation expiry");
      const expected = status.last_outcome === "throttled" ? "rate_limited" : status.last_outcome === "busy" ? "busy" : ["failed", "never"].includes(status.last_outcome) || !status.last_valid ? "unknown" : null;
      if (expected && status.condition !== expected) throw new Error("status condition");
      if (status.display_code === "ready" && (status.condition !== "ready" || !status.last_valid || status.last_valid.problems.length || status.last_valid.warnings.length)) throw new Error("false ready");
      return status;
    }
    throw new Error("operation data");
  }
  if (out.request_id === null || out.op === null) {
    if (out.state !== "refused" || !["invalid_request", "unsupported_version", "unauthorized"].includes(out.reason ?? "") || out.data !== null) throw new Error("correlation");
    return out as Response;
  }
  if (out.data === null) { if (!["refused", "unavailable"].includes(out.state) || out.reason === null) throw new Error("missing data"); return out as Response; }
  if (out.op === "recover") {
    if (out.state !== "ok" || out.reason !== null) throw new Error("recovery envelope");
    const r = z.object({ original_request_id: id, original_op: z.enum(OPS).refine((v) => v !== "recover"), original_state: state, original_reason: reason, original_data: z.unknown() }).strict().parse(out.data);
    if (r.original_data === null && (!["refused", "unavailable"].includes(r.original_state) || r.original_reason === null)) throw new Error("missing original");
    const original = r.original_data === null ? null : data(r.original_op, r.original_data, r.original_state, r.original_reason);
    return { ...out, data: { ...r, original_data: original } } as Response;
  }
  const parsed = data(out.op, out.data, out.state, out.reason);
  return { ...out, data: parsed } as Response;
}

export function refusal(raw: unknown, reason: Reason, state: Response["state"] = "refused"): Response {
  const v = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  return { schema: "receipt-public/v1", request_id: id.safeParse(v.request_id).success ? v.request_id as string : null, op: z.enum(OPS).safeParse(v.op).success ? v.op as Op : null, state, reason, data: null };
}

/** A correctly shaped response must also describe the operation the caller reviewed. */
export function parseResponseFor(command: Command, value: unknown, devices: readonly string[] = RECEIPT_DEVICES): Response {
  const result = parseResponse(value, devices);
  if (result.request_id !== command.request_id || result.op !== command.op) throw new Error("response correlation");
  const d = result.data;
  if (!d) return result;
  if (command.op === "recover" && "original_request_id" in d && d.original_request_id !== command.args.original_request_id) throw new Error("recovery correlation");
  if ((command.op === "status_cached" || command.op === "status_refresh") && "device_id" in d && d.device_id !== command.args.device_id) throw new Error("device correlation");
  if (command.op === "observe" && "attempt" in d && (d.attempt.attempt_id !== command.args.attempt_id || d.attempt.observation !== command.args.observation)) throw new Error("observation correlation");
  if (!("review_handle" in d)) return result;
  if (command.op === "read_review" && d.review_handle !== command.args.review_handle) throw new Error("review correlation");
  if (command.op === "prepare_test" && (d.mode !== command.args.mode || d.documents.length !== 1 || d.documents[0].device_id !== command.args.device_id)) throw new Error("test correlation");
  if (command.op === "prepare") {
    const args = command.args;
    if (d.documents.length !== args.document_handles.length || d.documents.some((doc, i) => doc.document_handle !== args.document_handles[i] || doc.device_id !== args.device_ids[i] || doc.action !== args.action || doc.parent_attempt_id !== args.parent_attempt_ids[i] || doc.observation_id !== args.observation_ids[i])) throw new Error("selection correlation");
  }
  if (command.op === "re_review") {
    const args = command.args;
    if (d.documents.length !== args.reservation_handles.length || d.documents.some((doc, i) => doc.reservation_handle !== args.reservation_handles[i] || doc.device_id !== args.device_ids[i])) throw new Error("reservation correlation");
  }
  return result;
}
