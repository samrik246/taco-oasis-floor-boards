/** @vitest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { PrintButton } from "@/components/next/PrintButton";
import { NEXT_COPY } from "@/components/next/next-copy";

let root: Root;
afterEach(async () => { if (root) await act(async () => root.unmount()); vi.unstubAllGlobals(); document.body.innerHTML = ""; });
async function mount(getToken: () => Promise<string | null>, send: () => Promise<Response> = async () => Response.json({ status: "ok" })) {
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => init?.method === "POST" ? send() : Response.json({ printing: true, printed: false }));
  vi.stubGlobal("fetch", fetcher);
  const rejected = vi.fn(), uncertain = vi.fn();
  await act(async () => root.render(createElement(PrintButton, { tail: "SYN001", t: NEXT_COPY.en, getToken, onTokenRejected: rejected, uncertainTails: new Set<string>(), onUncertain: uncertain })));
  const button = () => host.querySelector<HTMLButtonElement>("button")!;
  return { host, fetcher, button, rejected, uncertain };
}

it("excludes repeated taps while unlocking and while sending", async () => {
  let unlock!: (token: string | null) => void, finish!: (response: Response) => void;
  const getToken = vi.fn(() => new Promise<string | null>(resolve => { unlock = resolve; }));
  const send = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; }));
  const h = await mount(getToken, send);
  await act(async () => { h.button().click(); h.button().click(); });
  expect(getToken).toHaveBeenCalledTimes(1); expect(send).not.toHaveBeenCalled();
  await act(async () => unlock("synthetic-session"));
  await act(async () => h.button().click()); expect(send).toHaveBeenCalledTimes(1);
  await act(async () => finish(Response.json({ status: "ok" })));
  expect(h.host.textContent).toContain(NEXT_COPY.en.reprint);
});

it("cancelled unlock sends nothing and allows a deliberate later attempt", async () => {
  const token = vi.fn(async () => null); const h = await mount(token);
  await act(async () => h.button().click()); await act(async () => h.button().click());
  expect(token).toHaveBeenCalledTimes(2);
  expect(h.fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
});

it("lost response reports uncertainty and removes the retry button", async () => {
  const h = await mount(async () => "synthetic-session", async () => { throw new Error("lost synthetic response"); });
  await act(async () => h.button().click());
  expect(h.uncertain).toHaveBeenCalledWith("SYN001"); expect(h.button()).toBeNull();
});

it("expired manager is forgotten after server rejection", async () => {
  const h = await mount(async () => "synthetic-expired", async () => new Response(null, { status: 401 }));
  await act(async () => h.button().click());
  expect(h.rejected).toHaveBeenCalledTimes(1); expect(h.uncertain).not.toHaveBeenCalled();
  expect(h.host.textContent).toContain(NEXT_COPY.en.printManagerOnly);
});
