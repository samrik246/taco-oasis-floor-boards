import { afterEach, expect, it, vi } from "vitest";
import { receiptTransport, requestId } from "@/lib/receipts/client";
import { parseCommand } from "@/lib/receipts/protocol";

const command = parseCommand({ schema: "receipt-browser/v1", request_id: "a".repeat(32), op: "read_defaults", args: {} });
const result = { schema: "receipt-public/v1", request_id: command.request_id, op: command.op, state: "unavailable", reason: "runtime_unavailable", data: null };
afterEach(() => vi.unstubAllGlobals());
it("creates independent 128-bit opaque IDs without randomUUID or a time fallback", () => {
  vi.stubGlobal("crypto", { getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto) });
  const ids = Array.from({ length: 32 }, () => requestId());
  expect(new Set(ids).size).toBe(32); expect(ids.every((v) => /^[0-9a-f]{32}$/.test(v))).toBe(true);
});
it("retains typed unavailable responses and authenticates without persisting the credential", async () => {
  const fetcher = vi.fn(async () => Response.json(result)); vi.stubGlobal("fetch", fetcher);
  expect(await receiptTransport(command, "synthetic-token")).toEqual(result);
  expect(fetcher).toHaveBeenCalledWith("/api/receipts", expect.objectContaining({ method: "POST", cache: "no-store", headers: expect.objectContaining({ "x-manager-session": "synthetic-token" }) }));
});
it("rejects wrong correlation, duplicate keys, invalid UTF8 and oversized responses", async () => {
  for (const body of [JSON.stringify({ ...result, request_id: "b".repeat(32) }), JSON.stringify(result).replace('"state":', '"state":"ok","state":'), new Uint8Array([0xc3, 0x28]), "x".repeat(65537)]) {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body)));
    await expect(receiptTransport(command, "synthetic-token")).rejects.toThrow();
  }
});
