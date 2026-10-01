import { z } from "zod";
import { RECEIPT_DEVICES, id, parseCommand, parseJSON, parseResponse, refusal, type Command, type Op, type Response as ReceiptResponse } from "./protocol";

export type HostCommand = { schema: "receipt-command/v1"; request_id: string; actor_id: string; op: Op; args: Record<string, unknown> };
type Plan = { plan_id: string; plan_sha256: string };
export type ReceiptDependencies = {
  devices?: readonly string[];
  authenticate: (req: Request) => Promise<string | null>;
  // Production deliberately supplies no engine. Tests inject a fake; there is
  // no env/browser switch to load one, no sender and no implicit state store.
  engine?: {
    contentHandles: (actor: string, handles: string[]) => Promise<string[]>;
    plan: (actor: string, review: string) => Promise<Plan>;
    rememberReview: (actor: string, review: string, plan: Plan) => Promise<void>;
    execute: (command: HostCommand) => Promise<string>;
  };
};
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const planSchema = z.object({ plan_id: id, plan_sha256: hash }).strict();
const privateDocument = z.object({ logical_key: hash, profile_sha256: hash, artifact_sha256: hash }).strict();

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("object");
  return value as Record<string, unknown>;
}

/** Explicit public projection; unknown keys remain and the strict schema rejects them. */
async function projectData(op: Op, raw: unknown, actor: string, engine: NonNullable<ReceiptDependencies["engine"]>): Promise<unknown> {
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
    const plan = planSchema.parse({ plan_id, plan_sha256 });
    id.parse(publicReview.review_handle);
    if (!Array.isArray(documents)) throw new Error("documents");
    // Bind only after the full public shape is checked below by the caller.
    return { ...publicReview, documents: documents.map(document), _plan: plan };
  }
  if (op === "submit") {
    if (!Array.isArray(v.documents)) throw new Error("documents");
    return { ...v, documents: v.documents.map(document) };
  }
  if (op === "observe") return { ...v, attempt: document(v.attempt) };
  if (op === "recover") {
    if (v.original_op === "recover") throw new Error("recursive recovery");
    return { ...v, original_data: await projectData(v.original_op as Op, v.original_data, actor, engine) };
  }
  return v;
}

export async function translateResult(raw: string, command: Command, actor: string, engine: NonNullable<ReceiptDependencies["engine"]>, devices: readonly string[] = RECEIPT_DEVICES): Promise<ReceiptResponse> {
  // Exactly one JSON line, including its complete recovery wrapper, <=64 KiB.
  if (raw.trim().includes("\n")) throw new Error("line");
  const v = object(parseJSON(raw, 65536));
  if (v.schema !== "receipt-result/v1" || v.request_id !== command.request_id || v.op !== command.op) throw new Error("correlation");
  const projected = await projectData(command.op, v.data, actor, engine);
  const bindings: { handle: string; plan: Plan }[] = [];
  const extract = (rawData: unknown): unknown => {
    if (rawData === null) return null;
    const obj = object(rawData);
    if ("_plan" in obj) {
      const { _plan, ...rest } = obj;
      bindings.push({ handle: id.parse(rest.review_handle), plan: planSchema.parse(_plan) });
      return rest;
    }
    if ("original_data" in obj) return { ...obj, original_data: extract(obj.original_data) };
    return obj;
  };
  const out = parseResponse({ ...v, schema: "receipt-public/v1", data: extract(projected) }, devices);
  if (new TextEncoder().encode(JSON.stringify(out) + "\n").length > 65536) throw new Error("public size");
  if (command.op === "recover" && out.data && "original_request_id" in out.data && out.data.original_request_id !== command.args.original_request_id) throw new Error("recovery correlation");
  if ((command.op === "status_cached" || command.op === "status_refresh") && out.data && "device_id" in out.data && out.data.device_id !== command.args.device_id) throw new Error("device correlation");
  for (const binding of bindings) await engine.rememberReview(actor, binding.handle, binding.plan);
  return out;
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

export async function handleReceipt(req: Request, dependencies: ReceiptDependencies): Promise<Response> {
  let raw: unknown;
  try { raw = await body(req); } catch { return send(refusal(null, "invalid_request"), 400); }
  const origin = req.headers.get("origin");
  if ((origin && origin !== new URL(req.url).origin) || req.headers.get("sec-fetch-site") === "cross-site" || !req.headers.get("x-manager-session")) return send(refusal(raw, "unauthorized"), 401);
  let actor: string | null;
  try { actor = await dependencies.authenticate(req); } catch { return send(refusal(raw, "unauthorized"), 503); }
  if (!actor || !id.safeParse(actor).success) return send(refusal(raw, "unauthorized"), 401);
  let command: Command;
  try { command = parseCommand(raw, dependencies.devices); } catch {
    const version = raw && typeof raw === "object" && "schema" in raw ? (raw as { schema: unknown }).schema : undefined;
    return send(refusal(raw, typeof version === "string" && version !== "receipt-browser/v1" ? "unsupported_version" : "invalid_request"), 400);
  }
  const engine = dependencies.engine;
  if (!engine) return send(refusal(command, command.op === "recover" ? "history_unavailable" : "runtime_unavailable", "unavailable"), 503);
  try {
    let args: Record<string, unknown> = command.args;
    if (command.op === "prepare") {
      const { document_handles, ...rest } = command.args;
      const handles = await engine.contentHandles(actor, document_handles);
      if (handles.length !== document_handles.length || new Set(handles).size !== handles.length || !handles.every((h) => id.safeParse(h).success)) throw new Error("content binding");
      args = { ...rest, content_handles: handles };
    } else if (command.op === "read_review" || command.op === "submit") {
      args = planSchema.parse(await engine.plan(actor, command.args.review_handle));
    }
    const result = await engine.execute({ schema: "receipt-command/v1", request_id: command.request_id, actor_id: actor, op: command.op, args });
    return send(await translateResult(result, command, actor, engine, dependencies.devices));
  } catch {
    // A missing response is not a no-send receipt. Preserve the original ID.
    const why = command.op === "recover" ? "history_unavailable" : command.op === "status_refresh" || command.op === "status_cached" ? "query_unavailable" : "result_unconfirmed";
    return send(refusal(command, why, "unavailable"), 503);
  }
}
