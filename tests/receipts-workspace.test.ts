/** @vitest-environment jsdom */
import { TextDecoder, TextEncoder } from "node:util";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ReceiptWorkspace } from "@/components/receipts/ReceiptWorkspace";
import { type Command, type Response, type Review } from "@/lib/receipts/protocol";
import { type ReceiptTransport } from "@/lib/receipts/client";
import { devices, fixtures, review, batch, response, status } from "./helpers/receipt-fixtures";

const manager = { id: "synthetic-manager", token: "synthetic-session" };
const key = "receipt-journal-v1:" + manager.id;
const roots: Root[] = [];
const newReview = (): Review => ({ ...review(), created_at: new Date(Date.now()).toISOString(), expires_at: new Date(Date.now() + 300000).toISOString() });
const baseTransport = async (c: Command): Promise<Response> => {
  if (c.op === "read_defaults" || c.op === "save_defaults") return response(c, fixtures.common_setup.defaults);
  if (c.op === "status_cached" || c.op === "status_refresh") return response(c, { ...status(), device_id: c.args.device_id });
  if (["prepare", "prepare_test", "re_review"].includes(c.op)) return response(c, newReview());
  if (c.op === "submit") return response(c, batch());
  return response(c, null, "unavailable", "history_unavailable");
};
async function mount(transport = vi.fn<ReceiptTransport>(baseTransport), locale: "es" | "en" = "en", id = manager.id) {
  const host = document.createElement("div"); document.body.appendChild(host);
  const root = createRoot(host); roots.push(root); const onLock = vi.fn();
  await act(async () => root.render(createElement(ReceiptWorkspace, { manager: { ...manager, id }, documents: review().documents, devices, transport, locale, onLock })));
  const button = (name: string) => {
    const b = [...host.querySelectorAll<HTMLButtonElement>("button")].find((v) => v.textContent === name);
    if (!b) throw new Error("missing button: " + name); return b;
  };
  const click = async (name: string) => act(async () => button(name).click());
  const choose = async () => { await click(locale === "en" ? "Load current destinations" : "Cargar destinos actuales"); await act(async () => { host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((box) => box.click()); }); await click(locale === "en" ? "Use default destinations" : "Usar destinos predeterminados"); };
  const preview = async () => { await choose(); await click(locale === "en" ? "Review tickets and destinations" : "Revisar boletos y destinos"); };
  return { host, root, transport, onLock, button, click, choose, preview };
}
beforeEach(() => { vi.stubGlobal("TextEncoder", TextEncoder); vi.stubGlobal("TextDecoder", TextDecoder); sessionStorage.clear(); });
afterEach(async () => { await act(async () => { roots.splice(0).forEach((r) => r.unmount()); }); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); document.body.innerHTML = ""; });

for (const locale of ["es", "en"] as const) it(`${locale}: opening makes no query or send; defaults and order choices stay separate`, async () => {
  const h = await mount(undefined, locale); expect(h.transport).not.toHaveBeenCalled();
  await h.choose();
  const selected = () => [...h.host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].map((x) => x.checked);
  expect(selected()).toEqual([true, true]);
  await h.click(locale === "en" ? "Save default destinations" : "Guardar destinos predeterminados");
  expect(h.transport.mock.calls.map(([c]) => c.op)).toEqual(["read_defaults"]);
  await h.click(locale === "en" ? "Confirm destinations" : "Confirmar destinos");
  expect(h.transport.mock.calls.map(([c]) => c.op)).toEqual(["read_defaults", "save_defaults"]);
  expect(selected()).toEqual([true, true]);
  await h.click(locale === "en" ? "Review tickets and destinations" : "Revisar boletos y destinos");
  expect(h.host.textContent).toContain("2.04 lb TEST ITEM");
  expect(h.transport.mock.calls.at(-1)?.[0]).toMatchObject({ op: "prepare", args: { action: "original", device_ids: [devices[0], devices[1]], parent_attempt_ids: [null, null] } });
});

it("an immutable preview is invalidated by route changes and expiry prevents submit", async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-01T04:00:00Z"));
  const h = await mount(); await h.preview();
  expect(h.button("Print 2 tickets").disabled).toBe(false);
  await act(async () => vi.advanceTimersByTime(300001));
  expect(h.button("Print 2 tickets").disabled).toBe(true);
  await act(async () => {
    const select = h.host.querySelector<HTMLSelectElement>('select[aria-label="Ticket destination FRIO"]')!;
    select.value = devices[2]; select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(h.host.textContent).not.toContain("2.04 lb TEST ITEM");
  expect(h.transport.mock.calls.some(([c]) => c.op === "submit")).toBe(false);
});

it("double tap and lost response preserve one original request; recovery never resubmits", async () => {
  let reject!: (reason: Error) => void;
  const pending = new Promise<Response>((_, no) => { reject = no; });
  const transport = vi.fn<ReceiptTransport>(async (c) => c.op === "submit" ? pending : c.op === "recover" ? response(c, { original_request_id: c.args.original_request_id, original_op: "submit", original_state: "ok", original_reason: null, original_data: batch() }) : baseTransport(c));
  const h = await mount(transport); await h.preview();
  await act(async () => { h.button("Print 2 tickets").click(); h.button("Print 2 tickets").click(); });
  const submits = transport.mock.calls.filter(([c]) => c.op === "submit"); expect(submits).toHaveLength(1);
  await act(async () => reject(new Error("response lost")));
  const journal = JSON.parse(sessionStorage.getItem(key)!);
  expect(journal.pending.request_id).toBe(submits[0][0].request_id);
  expect(h.host.textContent).toContain("Paper may have printed");
  await h.click("Review this attempt");
  expect(transport.mock.calls.at(-1)?.[0]).toMatchObject({ op: "recover", args: { original_request_id: submits[0][0].request_id } });
  expect(transport.mock.calls.filter(([c]) => c.op === "submit")).toHaveLength(1);
  expect(h.host.textContent).toContain("Sent · check paper");
  expect(JSON.parse(sessionStorage.getItem(key)!).pending).toBeNull();
});

it("reload retains unresolved identity, isolates managers, and unavailable history blocks mutation", async () => {
  const original = { request_id: "a".repeat(32), op: "submit" };
  sessionStorage.setItem(key, JSON.stringify({ pending: original, entries: [original] }));
  const h = await mount(); expect(h.transport).not.toHaveBeenCalled();
  await h.click("Review this attempt");
  expect(h.button("Review tickets and destinations").disabled).toBe(true);
  expect(JSON.parse(sessionStorage.getItem(key)!).pending).toEqual(original);
  const other = await mount(undefined, "en", "different-manager");
  expect(other.host.textContent).not.toContain("previous attempt still needs review");
  expect(other.transport).not.toHaveBeenCalled();
});

it("history loss while checking an earlier completed request also prevents a new action", async () => {
  const old = { request_id: "a".repeat(32), op: "submit" };
  sessionStorage.setItem(key, JSON.stringify({ pending: null, entries: [old] }));
  const h = await mount(); await h.click("Review record 1");
  expect(JSON.parse(sessionStorage.getItem(key)!).pending).toEqual(old);
  expect(h.button("Review tickets and destinations").disabled).toBe(true);
});

it("storage failure prevents sending and late unmounted completion leaves recoverable ID", async () => {
  const h = await mount(); await h.choose();
  const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
  await h.click("Review tickets and destinations");
  expect(h.transport.mock.calls.some(([c]) => c.op === "prepare")).toBe(false); spy.mockRestore();
  let resolve!: (v: Response) => void;
  const transport = vi.fn<ReceiptTransport>(async (c) => c.op === "prepare" ? new Promise<Response>((yes) => { resolve = yes; }) : baseTransport(c));
  const late = await mount(transport); await late.choose(); await late.click("Review tickets and destinations");
  const c = transport.mock.calls.at(-1)![0];
  await act(async () => late.root.unmount()); roots.splice(roots.indexOf(late.root), 1);
  await act(async () => resolve(response(c, newReview())));
  expect(JSON.parse(sessionStorage.getItem(key)!).pending.request_id).toBe(c.request_id);
  expect(late.host.textContent).toBe("");
});

it("partial outcomes stay per-document; not_seen allows only a reviewed marked child", async () => {
  const rows = batch(); rows.documents[1].state = "uncertain"; rows.documents[1].reason = "result_unconfirmed";
  const transport = vi.fn<ReceiptTransport>(async (c) => {
    if (c.op === "submit") return response(c, rows, "partial", "result_unconfirmed");
    if (c.op === "observe") { const row = rows.documents.find((d) => d.attempt_id === c.args.attempt_id)!; return response(c, { observation_id: "d".repeat(32), attempt: { ...row, observation: c.args.observation, observation_id: "d".repeat(32), allowed_actions: c.args.observation === "pending" ? ["observe"] : ["observe", "cambio"] } }); }
    return baseTransport(c);
  });
  const h = await mount(transport); await h.preview(); await h.click("Print 2 tickets");
  expect(h.host.textContent).toContain("Sent · check paper"); expect(h.host.textContent).toContain("Result unconfirmed");
  await h.click("Not checked yet"); expect(h.host.textContent).not.toContain("Prepare CAMBIO copy");
  await h.click("I did not see paper"); expect(h.button("Prepare CAMBIO copy").disabled).toBe(true);
  expect(h.host.textContent).toContain("Paper may have printed");
  expect(transport.mock.calls.filter(([c]) => c.op === "submit")).toHaveLength(1);
});

it("cached/explicit diagnostics target one device and failed refresh never promotes old status", async () => {
  const good = { ...status(), last_outcome: "valid" as const, display_code: "ready" as const, condition: "ready" as const, last_valid: { observed_at: new Date(Date.now()).toISOString(), expires_at: new Date(Date.now() + 60000).toISOString(), condition: "ready" as const, identity_match: true as const, problems: [], warnings: [] } };
  const transport = vi.fn<ReceiptTransport>(async (c) => c.op === "status_cached" ? response(c, good) : c.op === "status_refresh" ? response(c, null, "unavailable", "query_unavailable") : baseTransport(c));
  const h = await mount(transport); await h.click("View saved status");
  expect(h.host.textContent).toContain("No warnings · recent response");
  await h.click("Check status"); expect(h.host.textContent).not.toContain("No warnings · recent response");
  expect(h.host.textContent).toContain("last valid response time is retained");
  expect(transport.mock.calls.map(([c]) => c)).toEqual([expect.objectContaining({ op: "status_cached", args: { device_id: devices[0] } }), expect.objectContaining({ op: "status_refresh", args: { device_id: devices[0] } })]);
  await h.click("Prepare test"); expect(transport.mock.calls.at(-1)?.[0]).toMatchObject({ op: "prepare_test", args: { device_id: devices[0], mode: "manager_test" } });
  expect(transport.mock.calls.some(([c]) => c.op === "submit")).toBe(false);
});
