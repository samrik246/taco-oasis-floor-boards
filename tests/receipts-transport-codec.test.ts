import { describe, expect, it } from "vitest";
import { canonical, decodeLine, digest, LIMITS, line, prepareCall, ReadyCollector, ReplyCollector, type Correlation, type Header } from "@/lib/receipts/transport-codec";
import { parseWorkerConfig } from "@/lib/receipts/transport-config";
import { configValue, reply, transportGeneration } from "./helpers/receipt-transport";
import { actor, devices, first } from "./helpers/receipt-fixtures";

const correlation: Correlation = { generation: transportGeneration, call_id: "b".repeat(32), method: "lookup_request" };

it("canonical bytes preserve supplementary Unicode, escapes, ordered arrays and safe integers", () => {
  const value = { z: [null, true, 9007199254740991], a: "🎉\n\u0001\t\"\\" };
  const expected = '{"a":"🎉\\n\\u0001\\t\\\"\\\\","z":[null,true,9007199254740991]}';
  expect(canonical(value)).toBe(expected);
  expect(decodeLine(Buffer.from(expected + "\n"), 8192)).toEqual(value);
});
it.each([NaN, Infinity, 1.2, 9007199254740992, "\ud800", { "🎉": 1 }, undefined, new Date(), Array(2)])("rejects a noncanonical scalar/key/array %s", (v) => expect(() => canonical(v)).toThrow());
it.each(['{"x":1,"x":2}\n', '{"x":1.0}\n', '{ "x":1}\n', '{"x":-0}\n', '\ufeff{}\n', '{}\r\n', '{}\n\n', '{}', '{"x":"\\ud800"}\n'])('refuses malformed canonical line %j', (text) => expect(() => decodeLine(Buffer.from(text), 8192)).toThrow());
it("refuses invalid UTF8 before JSON decoding", () => expect(() => decodeLine(Uint8Array.from([123,34,97,34,58,34,0xc0,0xaf,34,125,10]), 8192)).toThrow());

it("snapshots the complete browser command but fills one dispatch clock into its byte template", () => {
  const browser = first().request;
  const call = prepareCall({ method: "lookup_request", authenticated_actor: actor, args: { browser_command: browser } }, correlation, devices);
  const before = structuredClone(browser); browser.args = {} as typeof browser.args;
  const now = "2026-10-01T06:00:00.001Z";
  const bytes = call.dispatch(now);
  expect(bytes.length).toBe(call.byteLength);
  expect(decodeLine(bytes, 8192)).toEqual({ schema: "receipt-adapter-call/v1", ...correlation, authenticated_actor: actor, args: { browser_command: before, now } });
  expect(() => call.dispatch("tomorrow")).toThrow();
});
it.each([[], Array(5).fill("a".repeat(32)), ["a".repeat(32), "a".repeat(32)]])("enforces 1..4 unique content handles", (handles) => expect(() => prepareCall({ method: "content_handles", authenticated_actor: actor, args: { handles } }, { ...correlation, method: "content_handles" }, devices)).toThrow());
it("rejects extra private fields and diagnostic commands before preparing bytes", () => {
  const browser = { schema: "receipt-browser/v1", op: "status_refresh", request_id: "a".repeat(32), args: { device_id: devices[0] } } as const;
  expect(() => prepareCall({ method: "lookup_request", authenticated_actor: actor, args: { browser_command: browser } }, correlation, devices)).toThrow();
  expect(() => prepareCall({ method: "plan", authenticated_actor: actor, args: { review_handle: "a".repeat(32), protocol_version: 2 } } as never, { ...correlation, method: "plan" }, devices)).toThrow();
});

describe("bounded raw result collector", () => {
  it.each(["ASCII", "multibyte"])("accepts exactly 65536 raw bytes (%s), including LF", (kind) => {
    const prefix = Buffer.from(JSON.stringify({ message: kind === "ASCII" ? '"\\' : '🎉"\\' }));
    const body = Buffer.concat([prefix, Buffer.alloc(65535 - prefix.length, 32), Buffer.from("\n")]);
    const bytes = reply(correlation, body, { kind: "bound" });
    for (const split of [1, 100, bytes.length - body.length, bytes.length - 2]) {
      const collector = new ReplyCollector(correlation);
      expect(collector.push(bytes.subarray(0, split))).toBeNull();
      expect(collector.push(bytes.subarray(split))!.body.equals(body)).toBe(true);
    }
  });
  it("accepts absence only after its complete correlated header and empty-body hash", () => {
    const collector = new ReplyCollector(correlation);
    const bytes = reply(correlation);
    expect(collector.push(bytes.subarray(0, -1))).toBeNull();
    expect(collector.push(bytes.subarray(-1))!.header.kind).toBe("absent");
    expect(() => collector.push(Buffer.from("\n"))).toThrow();
  });
  it.each([
    { generation: "c".repeat(64) }, { call_id: "c".repeat(32) }, { method: "plan" },
    { body_bytes: 65537, kind: "bound", body_kind: "result" },
    { body_bytes: 1 }, { body_sha256: "c".repeat(64) },
    { status: "unknown", kind: "absent" }, { kind: null },
  ])("rejects header/correlation/limit inconsistency %j", (fields) => expect(() => new ReplyCollector(correlation).push(reply(correlation, Buffer.alloc(0), fields as Partial<Header>))).toThrow());
  it.each([Buffer.alloc(1025, 32), Buffer.from('{}\n'), Buffer.concat([reply(correlation), Buffer.from("\n")])])("rejects over-limit, malformed or extra buffered output", (bytes) => expect(() => new ReplyCollector(correlation).push(bytes)).toThrow());
  it.each(['{}', '{}\r\n', '{}\n\n', '{"x":1,"x":2}\n'])("rejects invalid raw result frame %j", (text) => expect(() => new ReplyCollector(correlation).push(reply(correlation, Buffer.from(text), { kind: "bound" }))).toThrow());
  it("rejects a body hash mismatch without accepting the nominal frame", () => {
    expect(() => new ReplyCollector(correlation).push(reply(correlation, Buffer.from('{}\n'), { kind: "bound", body_sha256: "1".repeat(64) }))).toThrow();
  });
  it("bounds READY and rejects extra startup output", () => {
    expect(() => new ReadyCollector().push(Buffer.alloc(1025))).toThrow();
    expect(() => new ReadyCollector().push(Buffer.from('{}\n{}\n'))).toThrow();
  });
});

it("validates both retained config inventories and exact canonical hashes", () => {
  const c = configValue(); const bytes = line(c, LIMITS.config);
  expect(parseWorkerConfig(bytes, digest(bytes))).toEqual(c);
});
it.each(["root", "inode", "hash", "device", "extra", "constructor-field", "authority", "profile"])("refuses config binding mismatch %s", (which) => {
  const c = configValue();
  if (which === "root") c.ownership_attestation.root += "-different";
  if (which === "inode") c.store_attestation.root_identity[1]++;
  if (which === "hash") c.store_attestation_sha256 = "f".repeat(64);
  if (which === "device") c.ownership_attestation.devices.reverse();
  if (which === "extra") (c.ownership_attestation.files as Record<string, number[]>)["extra.lock"] = [1, 99];
  if (which === "constructor-field") delete (c as Partial<typeof c>).store_attestation;
  if (which === "authority") c.authority.profile_sha256.push(c.authority.profile_sha256[0]);
  if (which === "profile") c.catalog.devices[0].commissioned_for_orders = true;
  const bytes = line(c, LIMITS.config);
  expect(() => parseWorkerConfig(bytes, digest(bytes))).toThrow();
});
