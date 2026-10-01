import { managerAuthHeaders } from "@/lib/managers/auth-headers";
import { parseJSON, parseResponseFor, type Command, type Response } from "./protocol";

export type ReceiptTransport = (command: Command, token: string) => Promise<Response>;
// getRandomValues is available on the existing HTTP tablet origin as well as
// secure origins. No time/random fallback may weaken the 128-bit request ID.
export const requestId = () => [...crypto.getRandomValues(new Uint8Array(16))].map((byte) => byte.toString(16).padStart(2, "0")).join("");

export const receiptTransport: ReceiptTransport = async (command, token) => {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const res = await fetch("/api/receipts", { method: "POST", headers: { "content-type": "application/json", ...managerAuthHeaders(token) }, body: JSON.stringify(command), signal: controller.signal, cache: "no-store" });
    if (!res.body) throw new Error("missing response");
    const reader = res.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
    try {
      for (;;) { const part = await reader.read(); if (part.done) break; length += part.value.length; if (length > 65536) { await reader.cancel(); throw new Error("response size"); } chunks.push(part.value); }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const result = parseResponseFor(command, parseJSON(new TextDecoder("utf-8", { fatal: true }).decode(bytes), 65536));
    if (result.request_id !== command.request_id || result.op !== command.op) throw new Error("response correlation");
    if (command.op === "recover" && result.data && "original_request_id" in result.data && result.data.original_request_id !== command.args.original_request_id) throw new Error("original correlation");
    return result;
  } finally { clearTimeout(timer); }
};
