/** @vitest-environment jsdom */
import { TextDecoder, TextEncoder } from "node:util";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ReceiptWorkspace } from "@/components/receipts/ReceiptWorkspace";
import { parseResponse, type Command, type Response, type Review, type Status, type Batch, type Recovery } from "@/lib/receipts/protocol";
import { type ReceiptTransport } from "@/lib/receipts/client";
import { devices, fixtures, first, review, batch, response, status } from "./helpers/receipt-fixtures";
import closed from "../fixtures/receipts/closed-batch-examples-v1.json";
import { unfinished } from "./helpers/receipt-projection-fixtures";
import { eligibleClosedBatch, successorReview, successorResult } from "./helpers/receipt-successor-fixtures";

const manager = { id: "synthetic-manager", token: "synthetic-session" };
const key = "receipt-journal-v1:" + manager.id;
const roots: Root[] = [];
const newReview = (): Review => {
  const now = Date.now();
  return { ...review(), created_at: new Date(now).toISOString(), expires_at: new Date(now + 300000).toISOString() };
};
const newStatus = (): Status => {
  const now = Date.now();
  return { ...status(), last_outcome: "valid", display_code: "ready", condition: "ready", last_valid: { observed_at: new Date(now).toISOString(), expires_at: new Date(now + 60000).toISOString(), condition: "ready", identity_match: true, problems: [], warnings: [] } };
};
const baseTransport = async (c: Command): Promise<Response> => {
  if (c.op === "read_defaults" || c.op === "save_defaults") return response(c, fixtures.common_setup.defaults);
  if (c.op === "status_cached" || c.op === "status_refresh") return response(c, { ...status(), device_id: c.args.device_id });
  if (c.op === "prepare_test") {
    const r = newReview(); r.mode = c.args.mode; r.documents = [{ ...r.documents[0], device_id: c.args.device_id }]; r.total_documents = 1; r.totals = [{ device_id: c.args.device_id, count: 1 }];
    return response(c, r);
  }
  if (["prepare", "re_review"].includes(c.op)) return response(c, newReview());
  if (c.op === "submit") return response(c, batch());
  return response(c, null, "unavailable", "history_unavailable");
};
async function mount(transport = vi.fn<ReceiptTransport>(baseTransport), locale: "es" | "en" = "en", id = manager.id, documents = review().documents.map(({ document_handle, role }) => ({ document_handle, role }))) {
  const host = document.createElement("div"); document.body.appendChild(host);
  const root = createRoot(host); roots.push(root); const onLock = vi.fn();
  await act(async () => root.render(createElement(ReceiptWorkspace, { manager: { ...manager, id }, documents, devices, transport, locale, onLock })));
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

it("review fixtures retain exact expiry while clock reads advance one millisecond", () => {
  let now = Date.parse("2026-10-01T05:00:00.000Z");
  vi.spyOn(Date, "now").mockImplementation(() => now++);
  const data = newReview();
  const command = first().request;
  expect(Date.parse(data.expires_at) - Date.parse(data.created_at)).toBe(300000);
  expect(() => parseResponse(response(command, data), devices)).not.toThrow();
  for (const delta of [-1, 1]) {
    const invalid = { ...data, expires_at: new Date(Date.parse(data.expires_at) + delta).toISOString() };
    expect(() => parseResponse(response(command, invalid), devices)).toThrow("review");
  }
});

it("diagnostic fixtures retain exact expiry while clock reads advance one millisecond", () => {
  let now = Date.parse("2026-10-01T05:00:00.000Z");
  vi.spyOn(Date, "now").mockImplementation(() => now++);
  const data = newStatus();
  const command: Command = { schema: "receipt-browser/v1", request_id: "a".repeat(32), op: "status_cached", args: { device_id: data.device_id } };
  expect(Date.parse(data.last_valid!.expires_at) - Date.parse(data.last_valid!.observed_at)).toBe(60000);
  expect(() => parseResponse(response(command, data), devices)).not.toThrow();
  for (const delta of [-1, 1]) {
    const invalid = { ...data, last_valid: { ...data.last_valid!, expires_at: new Date(Date.parse(data.last_valid!.expires_at) + delta).toISOString() } };
    expect(() => parseResponse(response(command, invalid), devices)).toThrow("observation expiry");
  }
});

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
  const good = newStatus();
  const transport = vi.fn<ReceiptTransport>(async (c) => c.op === "status_cached" ? response(c, good) : c.op === "status_refresh" ? response(c, null, "unavailable", "query_unavailable") : baseTransport(c));
  const h = await mount(transport); await h.click("View saved status");
  expect(h.host.textContent).toContain("No warnings · recent response");
  await h.click("Check status"); expect(h.host.textContent).not.toContain("No warnings · recent response");
  expect(h.host.textContent).toContain("last valid response time is retained");
  expect(transport.mock.calls.map(([c]) => c)).toEqual([expect.objectContaining({ op: "status_cached", args: { device_id: devices[0] } }), expect.objectContaining({ op: "status_refresh", args: { device_id: devices[0] } })]);
  await h.click("Prepare test"); expect(transport.mock.calls.at(-1)?.[0]).toMatchObject({ op: "prepare_test", args: { device_id: devices[0], mode: "manager_test" } });
  expect(transport.mock.calls.some(([c]) => c.op === "submit")).toBe(false);
});

for (const locale of ["es", "en"] as const) for (const phase of ["failed", "busy", "throttled", "expired"] as const) it(`${locale}: RP1 retains all dated paper/cover faults after ${phase}`, async () => {
  const prior = { ...status(), last_request_at: "2026-10-01T04:01:05.000Z", last_probe_at: "2026-10-01T04:01:05.000Z", last_valid: { observed_at: "2026-10-01T04:00:00.000Z", expires_at: "2026-10-01T04:01:00.000Z", condition: "blocked" as const, identity_match: true as const, problems: ["paper_out", "cover_open"] as const, warnings: ["paper_near_end"] as const } };
  const old = { ...prior.last_valid, problems: [...prior.last_valid.problems], warnings: [...prior.last_valid.warnings] };
  const result = { ...prior, last_valid: old, last_outcome: phase === "expired" ? "valid" as const : phase, condition: phase === "expired" ? "stale" as const : phase === "throttled" ? "rate_limited" as const : phase === "busy" ? "busy" as const : "unknown" as const, display_code: phase === "expired" ? "stale" as const : phase === "throttled" ? "rate_limited" as const : phase === "busy" ? "busy" as const : "no_response" as const };
  const transport = vi.fn<ReceiptTransport>(async (c) => response(c, result));
  const h = await mount(transport, locale);
  await h.click(locale === "es" ? "Consultar estado" : "Check status");
  const saved = h.host.querySelector('aside[aria-label]')!;
  expect(saved.textContent).toContain(locale === "es" ? "Último estado conocido" : "Last known status");
  expect(saved.textContent).toContain(locale === "es" ? "Sin papel" : "Out of paper");
  expect(saved.textContent).toContain(locale === "es" ? "Tapa abierta" : "Cover open");
  expect(saved.textContent).toContain(locale === "es" ? "Revisar papel" : "Check paper");
  expect([...saved.querySelectorAll("time")].map((t) => t.dateTime)).toEqual([old.observed_at, old.expires_at]);
  expect(h.host.textContent).not.toContain(locale === "es" ? "Sin avisos · respuesta reciente" : "No warnings · recent response");
  expect(transport).toHaveBeenCalledTimes(1);
});

it("one explicit test requires a one-ticket review and a separate submit", async () => {
  let r: Review | null = null;
  const transport = vi.fn<ReceiptTransport>(async (c, token) => {
    if (c.op === "submit") {
      const b = batch(); b.documents = [{ ...b.documents[0], device_id: r!.documents[0].device_id }]; b.total_documents = 1;
      return response(c, b);
    }
    const value = await baseTransport(c);
    if (c.op === "prepare_test") r = value.data as Review;
    expect(token).toBe(manager.token); return value;
  });
  const h = await mount(transport); await h.click("View saved status"); await h.click("Prepare test");
  expect(h.host.querySelectorAll("pre")).toHaveLength(1);
  expect(h.host.textContent).toContain("One test ticket");
  expect(transport.mock.calls.map(([c]) => c.op)).toEqual(["status_cached", "prepare_test"]);
  await h.click("Send 1 test ticket");
  expect(transport.mock.calls.map(([c]) => c.op)).toEqual(["status_cached", "prepare_test", "submit"]);
  expect(transport.mock.calls[2][0]).toMatchObject({ args: { review_handle: r!.review_handle } });
});

for (const locale of ["es", "en"] as const) it(locale + ": original-ID recovery changes outcome without changing retained facts or sending", async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-01T04:00:00Z"));
  const steps = unfinished.positive_cases.find((c) => c.case_id === "U09")!.steps.filter((s) => s.request.op === "recover");
  const original = { request_id: (steps[0].request.args as { original_request_id: string }).original_request_id, op: "submit" };
  sessionStorage.setItem(key, JSON.stringify({ pending: original, entries: [original] }));
  let index = 0;
  const transport = vi.fn<ReceiptTransport>(async (command) => {
    if (command.op !== "recover" || index >= steps.length) throw new Error("synthetic response lost");
    return { ...structuredClone(steps[index++].expect.public_response!), request_id: command.request_id };
  });
  const h = await mount(transport, locale);
  const recover = locale === "es" ? "Revisar este intento" : "Review this attempt";
  expect(transport).not.toHaveBeenCalled();
  let firstRows: string[] | null = null;
  for (let turn = 0; turn < 3; turn++) {
    await h.click(recover);
    const message = turn === 1 ? locale === "es" ? "El estado actual no está confirmado" : "The current state is unconfirmed" : locale === "es" ? "Envío en curso" : "Send in progress";
    expect(h.host.querySelector('[role="alert"]')?.textContent).toContain(message);
    const rows = [...h.host.querySelectorAll('[data-testid="receipt-history-row"]')];
    const facts = rows.map((r) => r.textContent!);
    if (firstRows) expect(facts).toEqual(firstRows); else firstRows = facts;
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.textContent!.includes(locale === "es" ? "Último estado registrado" : "Last recorded state"))).toBe(true);
    expect(rows.every((r) => !r.querySelector("button,select,input"))).toBe(true);
    expect(rows.map((r) => r.querySelector("time")?.getAttribute("datetime"))).toEqual(["2000-01-01T00:00:02.000Z", "2000-01-01T00:00:01.000Z"]);
    expect(JSON.parse(sessionStorage.getItem(key)!).pending).toEqual(original);
    await act(async () => vi.advanceTimersByTime(30000));
    expect(transport).toHaveBeenCalledTimes(turn + 1);
    expect(transport.mock.calls.at(-1)?.[0]).toMatchObject({ op: "recover", args: { original_request_id: original.request_id } });
  }
  await h.click(recover); // A failed read cannot retain an earlier positive execution notice.
  expect(h.host.querySelector('[role="status"]')?.textContent).toContain(locale === "es" ? "Puede haber salido papel" : "Paper may have printed");
  expect([...h.host.querySelectorAll("p")].filter((p) => /^(Envío en curso|Send in progress)\./.test(p.textContent ?? ""))).toHaveLength(0);
  expect([...h.host.querySelectorAll('[data-testid="receipt-history-row"]')].map((r) => r.textContent)).toEqual(firstRows);
  expect(transport.mock.calls.every(([c]) => c.op === "recover")).toBe(true);
});

for (const locale of ["es", "en"] as const) it(locale + ": uncertain batches retain paper observations separately from unavailable history", async () => {
  const step = unfinished.positive_cases.find((c) => c.case_id === "U08")!.steps[1];
  const original = { request_id: (step.request.args as { original_request_id: string }).original_request_id, op: "submit" };
  sessionStorage.setItem(key, JSON.stringify({ pending: original, entries: [original] }));
  let reads = 0;
  const transport = vi.fn<ReceiptTransport>(async (c) => ++reads === 1 ? { ...structuredClone(step.expect.public_response!), request_id: c.request_id } : response(c, null, "unavailable", "history_unavailable"));
  const h = await mount(transport, locale);
  await h.click(locale === "es" ? "Revisar este intento" : "Review this attempt");
  expect(h.host.textContent).toContain(locale === "es" ? "Salió completo y legible" : "Complete and legible");
  expect(h.host.textContent).toContain(locale === "es" ? "Enviado · papel por revisar" : "Sent · check paper");
  expect(h.host.querySelector('[role="alert"]')?.textContent).toContain(locale === "es" ? "Puede haber salido papel" : "Paper may have printed");
  await h.click(locale === "es" ? "Revisar este intento" : "Review this attempt");
  expect(h.host.querySelector('[role="alert"]')?.textContent).toContain(locale === "es" ? "No se pudo leer el registro" : "Could not read the record");
  expect(h.host.textContent).toContain(locale === "es" ? "Salió completo y legible" : "Complete and legible");
  expect(transport.mock.calls.every(([c]) => c.op === "recover")).toBe(true);
});

for (const locale of ["es", "en"] as const) it(locale + ": direct pending submit allows only recovery and keeps its notice through other reads", async () => {
  const rows = batch(); rows.documents[1].state = "in_flight";
  rows.documents.forEach((d) => { d.allowed_actions = ["recover"]; });
  const transport = vi.fn<ReceiptTransport>(async (c) => c.op === "submit" ? response(c, rows, "pending") : baseTransport(c));
  const h = await mount(transport, locale); await h.preview();
  await h.click(locale === "es" ? "Imprimir 2 boletos" : "Print 2 tickets");
  const pending = () => h.host.querySelector('[role="status"]')?.textContent;
  expect(pending()).toContain(locale === "es" ? "Envío en curso" : "Send in progress");
  expect([...h.host.querySelectorAll('[data-testid="receipt-history-row"]')].every((r) => !r.querySelector("button,select"))).toBe(true);
  await h.click(locale === "es" ? "Cargar destinos actuales" : "Load current destinations");
  expect(pending()).toContain(locale === "es" ? "Envío en curso" : "Send in progress");
  expect(transport.mock.calls.filter(([c]) => c.op === "submit")).toHaveLength(1);
  expect(transport.mock.calls.some(([c]) => ["observe", "re_review"].includes(c.op))).toBe(false);
});


const closedExamples = closed.examples;
const closedIds = closedExamples.identities;
const closedEntries = [closedIds.submit_b1, closedIds.submit_b2].map((request_id) => ({ request_id, op: "submit" }));
const closedRecovery = (c: Command, which: 1 | 2): Response => ({ ...structuredClone(which === 1 ? closedExamples.original_id_b1_recovery.response : closedExamples.original_id_b2_recovery.response) as Response, request_id: c.request_id });

for (const locale of ["es", "en"] as const) for (const order of [[1, 2], [2, 1]]) it(locale + ": separate send groups survive arrival order " + order.join("-") + " and isolate observation", async () => {
  sessionStorage.setItem(key, JSON.stringify({ pending: closedEntries[1], entries: closedEntries }));
  const transport = vi.fn<ReceiptTransport>(async (c) => {
    if (c.op === "recover") return closedRecovery(c, c.args.original_request_id === closedIds.submit_b1 ? 1 : 2);
    if (c.op === "observe") return response(c, { observation_id: "e".repeat(32), attempt: { ...closedExamples.direct_b2_replay.response.data.documents[0], observation: c.args.observation, observation_id: "e".repeat(32), reservation_revision: 8, last_event_at: "2000-01-01T00:00:07.000Z" } } as Response["data"]);
    throw new Error("unexpected operation");
  });
  const h = await mount(transport, locale);
  for (const n of order) {
    await h.click((locale === "es" ? "Revisar registro " : "Review record ") + n);
    if (n === 1 && order[0] === 1) expect(JSON.parse(sessionStorage.getItem(key)!).pending).toEqual(closedEntries[1]);
  }
  const groups = [...h.host.querySelectorAll('[data-testid="receipt-history-group"]')];
  expect(groups).toHaveLength(2);
  const b1 = groups.find((g) => g.textContent!.includes(locale === "es" ? "No se intentó enviar en este envío" : "No send was attempted in this send"))!;
  const b2 = groups.find((g) => g !== b1)!;
  const old = b1.textContent;
  expect(b1.querySelectorAll("button,select,input")).toHaveLength(0);
  expect(b1.querySelector("time")?.dateTime).toBe("2000-01-01T00:00:02.000Z");
  expect(b2.querySelector("time")?.dateTime).toBe("2000-01-01T00:00:06.000Z");
  await h.click(locale === "es" ? "Salió completo y legible" : "Complete and legible");
  expect(b1.textContent).toBe(old);
  expect(b2.textContent).toContain(locale === "es" ? "Salió completo y legible" : "Complete and legible");
  expect(b2.querySelector("time")?.dateTime).toBe("2000-01-01T00:00:07.000Z");
  expect(transport.mock.calls.at(-1)?.[0]).toMatchObject({ op: "observe", args: { attempt_id: closedIds.attempt, observation: "accepted", evidence_handle: null } });
  expect(Object.keys((transport.mock.calls.at(-1)![0] as Extract<Command, { op: "observe" }>).args)).toEqual(["attempt_id", "observation", "evidence_handle"]);
  expect(transport.mock.calls.map(([c]) => c.op)).toEqual(["recover", "recover", "observe"]);
});

for (const locale of ["es", "en"] as const) it(locale + ": closed B1 stays unchanged during successor prepared/proven/unproven/terminal projections", async () => {
  sessionStorage.setItem(key, JSON.stringify({ pending: closedEntries[1], entries: closedEntries }));
  let phase = 0;
  const transport = vi.fn<ReceiptTransport>(async (c) => {
    if (c.op !== "recover") throw new Error("no automatic or device action");
    const out = closedRecovery(c, c.args.original_request_id === closedIds.submit_b1 ? 1 : 2);
    if (c.args.original_request_id === closedIds.submit_b2 && phase < 3) {
      const d = out.data as Recovery, row = (d.original_data as Batch).documents[0];
      d.original_state = phase === 2 ? "unavailable" : "pending";
      d.original_reason = phase === 2 ? "result_unconfirmed" : null;
      row.state = phase === 0 ? "prepared" : "in_flight"; row.allowed_actions = ["recover"];
      row.last_event_at = phase === 0 ? "2000-01-01T00:00:04.000Z" : "2000-01-01T00:00:05.000Z";
    }
    return out;
  });
  const h = await mount(transport, locale);
  const read = locale === "es" ? "Revisar registro " : "Review record ";
  await h.click(read + "1");
  const b1 = h.host.querySelector('[data-testid="receipt-history-group"]')!;
  const original = b1.textContent;
  for (; phase < 4; phase++) {
    await h.click(read + "2");
    if (phase < 3) expect(JSON.parse(sessionStorage.getItem(key)!).pending).toEqual(closedEntries[1]);
    await h.click(read + "1");
    expect(b1.textContent).toBe(original);
    if (phase < 3) expect(JSON.parse(sessionStorage.getItem(key)!).pending).toEqual(closedEntries[1]);
    expect(h.host.querySelectorAll('[data-testid="receipt-history-group"]')).toHaveLength(2);
  }
  expect(transport.mock.calls.every(([c]) => c.op === "recover")).toBe(true);
});

for (const locale of ["es", "en"] as const) for (const which of [1, 2] as const) it(locale + ": direct B" + which + " and its original-ID recovery update one group", async () => {
  let original = "";
  const direct = which === 1 ? closedExamples.direct_b1_replay.response : closedExamples.direct_b2_replay.response;
  const transport = vi.fn<ReceiptTransport>(async (c) => {
    if (c.op === "prepare") {
      const r = newReview(); r.documents = [{ ...r.documents[0], document_handle: closedIds.document, reservation_handle: closedIds.reservation, role: "FRIO", device_id: devices[0] }]; r.total_documents = 1; r.totals = [{ device_id: devices[0], count: 1 }]; return response(c, r);
    }
    if (c.op === "submit") { original = c.request_id; return { ...structuredClone(direct) as Response, request_id: original }; }
    if (c.op === "recover") {
      const out = closedRecovery(c, which); (out.data as Recovery).original_request_id = original; return out;
    }
    return baseTransport(c);
  });
  const h = await mount(transport, locale, manager.id, [{ document_handle: closedIds.document, role: "FRIO" }]);
  await h.choose();
  // Use the document's synthetic destination explicitly, independent of saved routes.
  await act(async () => { const select = h.host.querySelector<HTMLSelectElement>('select[aria-label$="FRIO"]')!; select.value = devices[0]; select.dispatchEvent(new Event("change", { bubbles: true })); });
  await h.click(locale === "es" ? "Revisar boletos y destinos" : "Review tickets and destinations");
  await h.click(locale === "es" ? "Imprimir 1 boleto" : "Print 1 ticket");
  expect(h.host.querySelectorAll('[data-testid="receipt-history-group"]')).toHaveLength(1);
  const old = h.host.querySelector('[data-testid="receipt-history-group"]')!.textContent;
  await h.click((locale === "es" ? "Revisar registro " : "Review record ") + "2");
  expect(h.host.querySelectorAll('[data-testid="receipt-history-group"]')).toHaveLength(1);
  expect(h.host.querySelector('[data-testid="receipt-history-group"]')!.textContent).toBe(old);
  expect(transport.mock.calls.filter(([c]) => c.op === "submit")).toHaveLength(1);
});

it("recovered observation without selected membership leaves both groups untouched and asks for original-send context", async () => {
  const observeEntry = { request_id: "f".repeat(32), op: "observe" };
  sessionStorage.setItem(key, JSON.stringify({ pending: null, entries: [...closedEntries, observeEntry] }));
  const transport = vi.fn<ReceiptTransport>(async (c) => {
    if (c.op !== "recover") throw new Error("recover only");
    if (c.args.original_request_id !== observeEntry.request_id) return closedRecovery(c, c.args.original_request_id === closedIds.submit_b1 ? 1 : 2);
    const row = { ...closedExamples.direct_b2_replay.response.data.documents[0], observation: "accepted", observation_id: "e".repeat(32) };
    return response(c, { original_request_id: observeEntry.request_id, original_op: "observe", original_state: "ok", original_reason: null, original_data: { observation_id: row.observation_id, attempt: row } } as Recovery);
  });
  const h = await mount(transport); await h.click("Review record 1"); await h.click("Review record 2");
  const before = [...h.host.querySelectorAll('[data-testid="receipt-history-group"]')].map((g) => g.textContent);
  await h.click("Review record 3");
  expect([...h.host.querySelectorAll('[data-testid="receipt-history-group"]')].map((g) => g.textContent)).toEqual(before);
  expect(h.host.querySelector('[role="alert"]')?.textContent).toContain("Review the send record");
});

for (const locale of ["es", "en"] as const) for (const recovered of [false, true]) it(`${locale}: eligible B1 loses only its controls at ${recovered ? "recovered" : "direct"} successor review before B2`, async () => {
  const b1 = eligibleClosedBatch();
  const other = structuredClone(b1); other.plan_handle = "c".repeat(32);
  Object.assign(other.documents[0], { document_handle: "d".repeat(32), reservation_handle: "e".repeat(32), attempt_id: "f".repeat(32) });
  const otherId = "9".repeat(32);
  sessionStorage.setItem(key, JSON.stringify({ pending: null, entries: [{ request_id: otherId, op: "submit" }] }));
  let firstSubmit = "", reviewId = "", submits = 0;
  const observed: { value: Response; bytes: string }[] = [];
  const transport = vi.fn<ReceiptTransport>(async (c) => {
    let result: Response;
    if (c.op === "prepare") result = response(c, successorReview(false, Date.now()));
    else if (c.op === "submit") {
      if (++submits === 1) { firstSubmit = c.request_id; result = response(c, b1, "refused", "sequence_not_started"); }
      else result = { ...successorResult(), request_id: c.request_id };
    } else if (c.op === "re_review") {
      reviewId = c.request_id;
      result = recovered ? response(c, null, "unavailable", "result_unconfirmed") : response(c, successorReview(true, Date.now()));
    } else if (c.op === "recover") {
      const rereview = c.args.original_request_id === reviewId;
      result = response(c, { original_request_id: c.args.original_request_id, original_op: rereview ? "re_review" : "submit", original_state: rereview ? "ok" : "refused", original_reason: rereview ? null : "sequence_not_started", original_data: rereview ? successorReview(true, Date.now()) : c.args.original_request_id === otherId ? other : b1 });
    } else result = await baseTransport(c);
    observed.push({ value: result, bytes: JSON.stringify(result) }); return result;
  });
  const h = await mount(transport, locale, manager.id, [{ document_handle: closedIds.document, role: "FRIO" }]);
  await h.preview(); await h.click(locale === "es" ? "Imprimir 1 boleto" : "Print 1 ticket");
  const old = h.host.querySelector('[data-testid="receipt-history-group"]')!;
  const facts = () => [...old.querySelectorAll("h3,p,time")].map((x) => x.outerHTML);
  const before = facts();
  expect(old.querySelector<HTMLButtonElement>("button")!.disabled).toBe(false);
  expect(old.querySelector<HTMLSelectElement>("select")!.disabled).toBe(false);
  await h.click((locale === "es" ? "Revisar registro " : "Review record ") + "1");
  const unrelated = h.host.querySelectorAll('[data-testid="receipt-history-group"]')[1];
  const untouched = unrelated.innerHTML;
  await h.click(locale === "es" ? "Revisar boletos pendientes" : "Review pending tickets");
  if (recovered) {
    expect(old.querySelectorAll("button,select")).toHaveLength(2);
    await h.click(locale === "es" ? "Revisar este intento" : "Review this attempt");
  }
  expect(old.querySelectorAll("button,select,input")).toHaveLength(0);
  expect(facts()).toEqual(before); expect(unrelated.innerHTML).toBe(untouched);
  expect(submits).toBe(1); // Suppression happens before B2 acceptance.
  await h.click(locale === "es" ? "Imprimir 1 boleto" : "Print 1 ticket");
  expect(h.host.querySelectorAll('[data-testid="receipt-history-group"]')).toHaveLength(3);
  expect(old.querySelectorAll("button,select,input")).toHaveLength(0);
  expect(facts()).toEqual(before); expect(unrelated.innerHTML).toBe(untouched);
  // A delayed old projection cannot re-enable this membership's stale controls.
  const entryIndex = JSON.parse(sessionStorage.getItem(key)!).entries.findIndex((e: { request_id: string }) => e.request_id === firstSubmit) + 1;
  await h.click((locale === "es" ? "Revisar registro " : "Review record ") + entryIndex);
  expect(old.querySelectorAll("button,select,input")).toHaveLength(0);
  expect(facts()).toEqual(before); expect(unrelated.innerHTML).toBe(untouched);
  expect(transport.mock.calls.map(([c]) => c.op)).toEqual(["read_defaults", "prepare", "submit", "recover", "re_review", ...(recovered ? ["recover"] : []), "submit", "recover"]);
  expect(observed.every(({ value, bytes }) => JSON.stringify(value) === bytes)).toBe(true);
});

for (const outcome of ["refused", "malformed", "same-plan", "older-revision", "other-reservation"] as const) it(`successor control suppression ignores ${outcome} review results`, async () => {
  const b1 = eligibleClosedBatch();
  const transport = vi.fn<ReceiptTransport>(async (c) => {
    if (c.op === "prepare") return response(c, successorReview(false, Date.now()));
    if (c.op === "submit") return response(c, b1, "refused", "sequence_not_started");
    if (c.op !== "re_review") return baseTransport(c);
    const r = successorReview(true, Date.now());
    if (outcome === "refused") return response(c, { ...r, submit_allowed: false, blocked_reason: "stale_plan" }, "refused", "stale_plan");
    if (outcome === "malformed") r.expires_at = r.created_at;
    if (outcome === "same-plan") r.plan_handle = b1.plan_handle;
    if (outcome === "older-revision") r.documents[0].reservation_revision = 2;
    if (outcome === "other-reservation") r.documents[0].reservation_handle = "e".repeat(32);
    return response(c, r);
  });
  const h = await mount(transport, "en", manager.id, [{ document_handle: closedIds.document, role: "FRIO" }]);
  await h.preview(); await h.click("Print 1 ticket");
  const old = h.host.querySelector('[data-testid="receipt-history-group"]')!;
  await h.click("Review pending tickets");
  expect(old.querySelectorAll("button,select")).toHaveLength(2);
  expect(old.querySelector("time")?.dateTime).toBe(b1.documents[0].last_event_at);
  expect(transport.mock.calls.map(([c]) => c.op)).toEqual(["read_defaults", "prepare", "submit", "re_review"]);
});
