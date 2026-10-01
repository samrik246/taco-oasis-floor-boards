import { z } from "zod";
import { RECEIPT_DEVICES, id, parseCommand, parseJSON, parseResponseFor, refusal, type Command, type Op, type Response as ReceiptResponse } from "./protocol";

export type HostCommand = { schema: "receipt-command/v1"; request_id: string; actor_id: string; op: Op; args: Record<string, unknown> };
export type Plan = { plan_id: string; plan_sha256: string };
export type Lookup = { kind: "absent" } | { kind: "bound" | "conflict" | "unavailable"; result: string };
export type Resolution<T> = { kind: "resolved"; value: T }
  | { kind: "unavailable"; reason: "history_unavailable" | "source_unavailable" }
  | { kind: "refused"; reason: "unauthorized" };
export type ExecutionContext = { authenticatedActor: string; browserCommand: Command };
export interface DurableReceiptAdapter {
  lookupRequest: (context: ExecutionContext) => Promise<Lookup>;
  contentHandles: (actor: string, handles: string[]) => Promise<Resolution<string[]>>;
  plan: (actor: string, review: string) => Promise<Resolution<Plan>>;
  execute: (command: HostCommand, context: ExecutionContext) => Promise<string>;
}
export type ReceiptDependencies = {
  devices?: readonly string[];
  authenticate: (req: Request) => Promise<string | null>;
  // Production deliberately supplies no engine. Tests inject a fake; there is
  // no env/browser switch to load one, no sender and no implicit state store.
  engine?: DurableReceiptAdapter;
};
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const planSchema = z.object({ plan_id: id, plan_sha256: hash }).strict();
const privateDocument = z.object({ logical_key: hash, profile_sha256: hash, artifact_sha256: hash }).strict();
const lookupSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("absent") }).strict(),
  ...(["bound", "conflict", "unavailable"] as const).map((kind) => z.object({ kind: z.literal(kind), result: z.string() }).strict()),
]);
const resolutionSchema = <T extends z.ZodType,>(value: T) => z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("resolved"), value }).strict(),
  z.object({ kind: z.literal("unavailable"), reason: z.enum(["history_unavailable", "source_unavailable"]) }).strict(),
  z.object({ kind: z.literal("refused"), reason: z.literal("unauthorized") }).strict(),
]);
const browserMutations: readonly Op[] = ["prepare", "prepare_test", "re_review", "submit", "observe", "save_defaults"];

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("object");
  return value as Record<string, unknown>;
}

/** Explicit public projection; unknown keys remain and the strict schema rejects them. */
function projectData(op: Op, raw: unknown): unknown {
  if (raw === null) return null;
  const v = object(raw);
  if ("_plan" in v) throw new Error("unknown field");
  const document = (rawDoc: unknown) => {
    const { logical_key, profile_sha256, artifact_sha256, ...publicDoc } = object(rawDoc);
    privateDocument.parse({ logical_key, profile_sha256, artifact_sha256 });
    return publicDoc;
  };
  if (["prepare", "prepare_test", "read_review", "re_review"].includes(op)) {
    const { plan_id, plan_sha256, documents, ...publicReview } = v;
    planSchema.parse({ plan_id, plan_sha256 });
    id.parse(publicReview.review_handle);
    if (!Array.isArray(documents)) throw new Error("documents");
    // The engine retains review mappings atomically. Projection has no cache
    // write that can erase an accepted result after a response is received.
    return { ...publicReview, documents: documents.map(document) };
  }
  if (op === "submit") {
    if (!Array.isArray(v.documents)) throw new Error("documents");
    return { ...v, documents: v.documents.map(document) };
  }
  if (op === "observe") return { ...v, attempt: document(v.attempt) };
  if (op === "recover") {
    if (v.original_op === "recover") throw new Error("recursive recovery");
    return { ...v, original_data: projectData(v.original_op as Op, v.original_data) };
  }
  return v;
}

export async function translateResult(raw: string, command: Command, devices: readonly string[] = RECEIPT_DEVICES): Promise<ReceiptResponse> {
  // One terminal LF, no other LF or CR. Count the untrimmed frame (including
  // its delimiter and complete recovery wrapper) against the 64 KiB bound.
  if (!raw.endsWith("\n") || raw.indexOf("\n") !== raw.length - 1 || raw.includes("\r")) throw new Error("line");
  const v = object(parseJSON(raw, 65536));
  if (v.schema !== "receipt-result/v1" || v.request_id !== command.request_id || v.op !== command.op) throw new Error("correlation");
  const projected = projectData(command.op, v.data);
  const out = parseResponseFor(command, { ...v, schema: "receipt-public/v1", data: projected }, devices);
  if (new TextEncoder().encode(JSON.stringify(out) + "\n").length > 65536) throw new Error("public size");
  if (command.op === "recover" && out.data && "original_request_id" in out.data && out.data.original_request_id !== command.args.original_request_id) throw new Error("recovery correlation");
  if ((command.op === "status_cached" || command.op === "status_refresh") && out.data && "device_id" in out.data && out.data.device_id !== command.args.device_id) throw new Error("device correlation");
  return out;
}

async function resolutionFailure(result: Exclude<Resolution<unknown>, { kind: "resolved" }>, command: Command, devices?: readonly string[]) {
  const raw = JSON.stringify({ ...refusal(command, result.reason, result.kind), schema: "receipt-result/v1" }) + "\n";
  return send(await translateResult(raw, command, devices), result.kind === "unavailable" ? 503 : 403);
}

async function body(req: Request): Promise<unknown> {
  if (req.headers.get("content-type")?.split(";")[0].trim() !== "application/json") throw new Error("content type");
  if (!req.body) throw new Error("body");
  const reader = req.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
  let expired = false;
  const timer = setTimeout(() => { expired = true; void reader.cancel(); }, 5000);
  try {
    for (;;) {
      const chunk = await reader.read(); if (chunk.done) break;
      total += chunk.value.length;
      if (total > 8192) { await reader.cancel(); throw new Error("size"); }
      chunks.push(chunk.value);
    }
  } finally { clearTimeout(timer); reader.releaseLock(); }
  if (expired) throw new Error("timeout");
  const bytes = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return parseJSON(new TextDecoder("utf-8", { fatal: true }).decode(bytes), 8192);
}

function send(response: ReceiptResponse, status = 200) {
  return Response.json(response, { status, headers: { "Cache-Control": "no-store" } });
}

function hasSameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true; // Session header still required for non-browser callers.
  try {
    // Next reconstructs Request.url with its internal hostname. Host is the
    // browser's actual destination authority; forwarded-host is not trusted.
    const url = new URL(req.url);
    const host = req.headers.get("host");
    const target = host ? new URL(`${url.protocol}//${host}`) : url;
    if (target.username || target.password || (host && (target.pathname !== "/" || target.search || target.hash))) return false;
    return origin === target.origin;
  } catch { return false; }
}

export async function handleReceipt(req: Request, dependencies: ReceiptDependencies): Promise<Response> {
  let raw: unknown;
  try { raw = await body(req); } catch { return send(refusal(null, "invalid_request"), 400); }
  if (!hasSameOrigin(req) || req.headers.get("sec-fetch-site") === "cross-site" || !req.headers.get("x-manager-session")) return send(refusal(raw, "unauthorized"), 401);
  let actor: string | null;
  try { actor = await dependencies.authenticate(req); } catch { return send(refusal(raw, "unauthorized"), 503); }
  if (!actor || !id.safeParse(actor).success) return send(refusal(raw, "unauthorized"), 401);
  let command: Command;
  try { command = freeze(structuredClone(parseCommand(raw, dependencies.devices))); } catch {
    const version = raw && typeof raw === "object" && "schema" in raw ? (raw as { schema: unknown }).schema : undefined;
    return send(refusal(raw, typeof version === "string" && version !== "receipt-browser/v1" ? "unsupported_version" : "invalid_request"), 400);
  }
  const engine = dependencies.engine;
  if (!engine) return send(refusal(command, command.op === "recover" ? "history_unavailable" : "runtime_unavailable", "unavailable"), 503);
  const context = freeze({ authenticatedActor: actor, browserCommand: command });
  try {
    // Old adapters cannot silently bypass the durable lookup contract.
    if (typeof engine.lookupRequest !== "function") throw new Error("lookup required");
    if (browserMutations.includes(command.op)) {
      const lookup = lookupSchema.parse(await engine.lookupRequest(context));
      if (lookup.kind !== "absent") {
        const result = await translateResult(lookup.result, command, dependencies.devices);
        if (lookup.kind === "conflict" && (result.state !== "refused" || result.reason !== "request_conflict" || result.data !== null)) throw new Error("lookup conflict");
        if (lookup.kind === "unavailable" && (result.state !== "unavailable" || result.reason !== "history_unavailable" || result.data !== null)) throw new Error("lookup unavailable");
        return send(result, result.state === "unavailable" ? 503 : 200);
      }
    }
    let args: Record<string, unknown> = command.args;
    if (command.op === "prepare") {
      const { document_handles, ...rest } = command.args;
      const resolved = resolutionSchema(z.array(id)).parse(await engine.contentHandles(actor, document_handles));
      if (resolved.kind !== "resolved") return await resolutionFailure(resolved, command, dependencies.devices);
      const handles = resolved.value;
      if (handles.length !== document_handles.length || new Set(handles).size !== handles.length || !handles.every((h) => id.safeParse(h).success)) throw new Error("content binding");
      args = { ...rest, content_handles: handles };
    } else if (command.op === "read_review" || command.op === "submit") {
      const resolved = resolutionSchema(planSchema).parse(await engine.plan(actor, command.args.review_handle));
      if (resolved.kind !== "resolved") return await resolutionFailure(resolved, command, dependencies.devices);
      args = resolved.value;
    }
    const result = await engine.execute(freeze({ schema: "receipt-command/v1", request_id: command.request_id, actor_id: actor, op: command.op, args }), context);
    return send(await translateResult(result, command, dependencies.devices));
  } catch {
    // A missing response is not a no-send receipt. Preserve the original ID.
    const why = command.op === "recover" ? "history_unavailable" : command.op === "status_refresh" || command.op === "status_cached" ? "query_unavailable" : "result_unconfirmed";
    return send(refusal(command, why, "unavailable"), 503);
  }
}
