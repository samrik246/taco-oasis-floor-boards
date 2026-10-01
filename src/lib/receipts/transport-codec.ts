import { createHash } from "node:crypto";
import { z } from "zod";
import { id, OPS, parseCommand, parseJSON, schemas, type Command } from "./protocol";
import { translateResult, type HostCommand } from "./host";

export const LIMITS = { call: 8192, header: 1024, result: 65536, resolution: 8192, config: 131072, stderr: 8192 } as const;
export const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const sha1Schema = z.string().regex(/^[a-f0-9]{40}$/);
export const safeInteger = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const METHODS = ["lookup_request", "content_handles", "plan", "execute_browser"] as const;
export type Method = typeof METHODS[number];
export type CallInput = { method: "lookup_request"; authenticated_actor: string; args: { browser_command: Command } }
  | { method: "execute_browser"; authenticated_actor: string; args: { browser_command: Command; host_command: HostCommand } }
  | { method: "content_handles"; authenticated_actor: string; args: { handles: string[] } }
  | { method: "plan"; authenticated_actor: string; args: { review_handle: string } };
export type Correlation = { generation: string; call_id: string; method: Method };
export const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** The private wire permits closed ASCII keys and safe integers only. */
export function canonical(value: unknown, depth = 0): string {
  if (depth > 32) throw new Error("depth");
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") {
    if (/[\ud800-\udfff]/u.test(value)) throw new Error("unicode");
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("integer");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length) throw new Error("array");
    return "[" + value.map((v) => canonical(v, depth + 1)).join(",") + "]";
  }
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return "{" + Object.keys(value).sort().map((key) => {
      if (!/^[\x20-\x7e]+$/.test(key)) throw new Error("key");
      return JSON.stringify(key) + ":" + canonical((value as Record<string, unknown>)[key], depth + 1);
    }).join(",") + "}";
  }
  throw new Error("value");
}

export function line(value: unknown, limit: number): Buffer {
  const bytes = Buffer.from(canonical(value) + "\n", "utf8");
  if (bytes.length > limit) throw new Error("size");
  return bytes;
}

export function decodeLine(bytes: Uint8Array, limit: number, requireCanonical = true): unknown {
  if (bytes.byteLength < 1 || bytes.byteLength > limit || bytes[bytes.byteLength - 1] !== 10) throw new Error("size/line");
  for (let i = 0; i < bytes.byteLength - 1; i++) if (bytes[i] === 10 || bytes[i] === 13) throw new Error("line");
  const raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  if (raw.charCodeAt(0) === 0xfeff) throw new Error("bom");
  const value = parseJSON(raw, limit);
  if (requireCanonical && canonical(value) + "\n" !== raw) throw new Error("canonical");
  return value;
}

const mutating = new Set(["prepare", "prepare_test", "re_review", "submit", "observe", "save_defaults"]);
export function privateCommand(value: unknown, devices: readonly string[]): HostCommand {
  const top = z.object({ schema: z.literal("receipt-command/v1"), request_id: id, actor_id: id, op: z.enum(OPS), args: z.unknown() }).strict().parse(value);
  const s = schemas(devices);
  let args: Record<string, unknown>;
  if (top.op === "submit" || top.op === "read_review") {
    args = z.object({ plan_id: id, plan_sha256: hashSchema }).strict().parse(top.args);
  } else if (top.op === "prepare") {
    const raw = z.object({ content_handles: z.array(id).min(1).max(4) }).passthrough().parse(top.args);
    const { content_handles, ...rest } = raw;
    const parsed = s.args.prepare.parse({ ...rest, document_handles: content_handles });
    const { document_handles, ...other } = parsed;
    args = { ...other, content_handles: document_handles };
  } else {
    args = s.args[top.op].parse(top.args);
  }
  if (top.op === "status_refresh") throw new Error("diagnostic off");
  const command = { ...top, args } as HostCommand;
  line(command, LIMITS.call);
  return command;
}

/** Prepare immutable canonical bytes once; fill only the server clock at dispatch. */
export function prepareCall(input: CallInput, correlation: Correlation, devices: readonly string[]) {
  const { generation, call_id, method } = z.object({ generation: hashSchema, call_id: id, method: z.enum(METHODS) }).strict().parse(correlation);
  if (input.method !== method) throw new Error("method");
  const actor = id.parse(input.authenticated_actor);
  let args: Record<string, unknown>;
  if (input.method === "content_handles") {
    args = z.object({ handles: z.array(id).min(1).max(4).refine((v) => new Set(v).size === v.length) }).strict().parse(input.args);
  } else if (input.method === "plan") {
    args = z.object({ review_handle: id }).strict().parse(input.args);
  } else {
    const raw = z.object({ browser_command: z.unknown(), ...(input.method === "execute_browser" ? { host_command: z.unknown() } : {}) }).strict().parse(input.args);
    const browser = parseCommand(raw.browser_command, devices);
    line(browser, LIMITS.call);
    if (browser.op === "status_refresh" || (input.method === "lookup_request" && !mutating.has(browser.op))) throw new Error("operation");
    args = { browser_command: browser, now: "2000-01-01T00:00:00.000Z" };
    if (input.method === "execute_browser") {
      const host = privateCommand((raw as { host_command: unknown }).host_command, devices);
      if (host.actor_id !== actor || host.request_id !== browser.request_id || host.op !== browser.op) throw new Error("binding");
      args.host_command = host;
    }
  }
  if (Object.keys(input).sort().join(",") !== "args,authenticated_actor,method") throw new Error("call fields");
  const template = line({ schema: "receipt-adapter-call/v1", generation, call_id, method, authenticated_actor: actor, args }, LIMITS.call);
  const marker = Buffer.from('"now":"2000-01-01T00:00:00.000Z"');
  const offset = "now" in args ? template.indexOf(marker) + 7 : -1;
  if ("now" in args && offset < 7) throw new Error("clock slot");
  return { correlation: { generation, call_id, method }, byteLength: template.length,
    async validate(frame: Frame) {
      if (frame.header.status !== "ok" || frame.header.kind === "absent") return;
      if (frame.header.body_kind === "result") {
        const value = await translateResult(frame.body.toString("utf8"), args.browser_command as Command, devices);
        if (method === "lookup_request") {
          if (frame.header.kind === "conflict" && (value.state !== "refused" || value.reason !== "request_conflict" || value.data !== null)) throw new Error("conflict result");
          if (frame.header.kind === "unavailable" && (value.state !== "unavailable" || value.reason !== "history_unavailable" || value.data !== null)) throw new Error("history result");
        }
      } else {
        const value = method === "plan"
          ? z.object({ plan_id: id, plan_sha256: hashSchema }).strict()
          : z.array(id).length((args.handles as string[]).length).refine((xs) => new Set(xs).size === xs.length);
        z.discriminatedUnion("kind", [
          z.object({ kind: z.literal("resolved"), value }).strict(),
          z.object({ kind: z.literal("unavailable"), reason: z.enum(["history_unavailable", "source_unavailable"]) }).strict(),
          z.object({ kind: z.literal("refused"), reason: z.literal("unauthorized") }).strict(),
        ]).parse(decodeLine(frame.body, LIMITS.resolution));
      }
    },
    dispatch(now: string) {
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(now) || !Number.isFinite(Date.parse(now)) || new Date(now).toISOString() !== now) throw new Error("clock");
      const bytes = Buffer.from(template);
      if (offset >= 0) Buffer.from(now).copy(bytes, offset);
      return bytes;
    },
  };
}

const replySchema = z.object({ schema: z.literal("receipt-adapter-reply/v1"), generation: hashSchema, call_id: id, method: z.enum(METHODS), status: z.enum(["ok", "history_unavailable", "unknown"]), kind: z.enum(["absent", "bound", "conflict", "unavailable"]).nullable(), body_kind: z.enum(["result", "resolution"]).nullable(), body_bytes: safeInteger, body_sha256: hashSchema }).strict();
export type Header = z.infer<typeof replySchema>;
export type Frame = { header: Header; body: Buffer };

function replyHeader(raw: unknown, expected: Correlation): Header {
  const h = replySchema.parse(raw);
  if (h.generation !== expected.generation || h.call_id !== expected.call_id || h.method !== expected.method) throw new Error("correlation");
  if (h.status !== "ok") {
    if (h.kind !== null || h.body_kind !== null || h.body_bytes !== 0) throw new Error("failure body");
  } else if (h.method === "lookup_request") {
    if (h.kind === "absent") { if (h.body_kind !== null || h.body_bytes !== 0) throw new Error("absent body"); }
    else if (h.kind === null || h.body_kind !== "result" || h.body_bytes < 1 || h.body_bytes > LIMITS.result) throw new Error("lookup body");
  } else if (h.method === "execute_browser") {
    if (h.kind !== null || h.body_kind !== "result" || h.body_bytes < 1 || h.body_bytes > LIMITS.result) throw new Error("execute body");
  } else if (h.kind !== null || h.body_kind !== "resolution" || h.body_bytes < 1 || h.body_bytes > LIMITS.resolution) throw new Error("resolution body");
  return h;
}

/** Never retains an oversized chunk: header then validated-size body only. */
export class ReplyCollector {
  private headerBytes = Buffer.alloc(LIMITS.header);
  private headerUsed = 0;
  private header: Header | null = null;
  private body: Buffer | null = null;
  private bodyUsed = 0;
  private done = false;
  constructor(private readonly expected: Correlation) {}
  push(chunk: Uint8Array): Frame | null {
    if (!chunk.length) return null;
    if (this.done) throw new Error("extra output");
    let offset = 0;
    if (!this.header) {
      while (offset < chunk.length) {
        if (this.headerUsed === LIMITS.header) throw new Error("header size");
        const byte = chunk[offset++]; this.headerBytes[this.headerUsed++] = byte;
        if (byte === 10) {
          this.header = replyHeader(decodeLine(this.headerBytes.subarray(0, this.headerUsed), LIMITS.header), this.expected);
          this.body = Buffer.alloc(this.header.body_bytes);
          break;
        }
      }
    }
    if (!this.header || !this.body) return null;
    const remaining = this.body.length - this.bodyUsed;
    if (chunk.length - offset > remaining) throw new Error("extra output");
    this.body.set(chunk.subarray(offset), this.bodyUsed); this.bodyUsed += chunk.length - offset;
    if (this.bodyUsed !== this.body.length) return null;
    if (digest(this.body) !== this.header.body_sha256) throw new Error("body hash");
    if (this.body.length) decodeLine(this.body, this.header.body_kind === "result" ? LIMITS.result : LIMITS.resolution, this.header.body_kind !== "result");
    this.done = true;
    return { header: this.header, body: this.body };
  }
}

export const readySchema = z.object({ schema: z.literal("receipt-adapter-ready/v1"), generation: hashSchema, pid: safeInteger.min(1), engine_sha: sha1Schema, application_inventory_sha256: hashSchema, config_sha256: hashSchema, capability: z.literal("association-only/v1") }).strict();
export class ReadyCollector {
  private bytes = Buffer.alloc(LIMITS.header);
  private used = 0;
  push(chunk: Uint8Array) {
    if (this.used + chunk.length > LIMITS.header) throw new Error("ready size");
    this.bytes.set(chunk, this.used); this.used += chunk.length;
    const lf = this.bytes.subarray(0, this.used).indexOf(10);
    if (lf < 0) return null;
    if (lf !== this.used - 1) throw new Error("extra ready");
    return readySchema.parse(decodeLine(this.bytes.subarray(0, this.used), LIMITS.header));
  }
}
