/** @vitest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ManagerBreakDialog } from "@/components/breaks/ManagerBreakDialog";
import type { Locale } from "@/lib/i18n";

const startAt = "2026-09-30T19:00:00.000Z";
const endAt = "2026-09-30T19:30:00.000Z";
const slot = { startAt, endAt };
const pending = {
  firstName: "Example", allowanceMinutes: 60, row: "this", shifts: [slot], slots: [], blocked: [],
  saved: null, pending: slot, state: "pending", approval: "gerente",
  covers: [{ kind: "simple", employeeId: "cover", shiftId: "shift", firstName: "Example Cover" },
    { kind: "shuffle", moves: [{ employeeId: "one", shiftId: "one", firstName: "One" }, { employeeId: "two", shiftId: "two", firstName: "Two" }] }],
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const roots: Root[] = [];
async function mount(locale: Locale, exit = true) {
  const host = document.createElement("div"); document.body.appendChild(host);
  const root = createRoot(host); roots.push(root);
  const onClose = vi.fn(), onExit = vi.fn(), onDenied = vi.fn(), onSaved = vi.fn(async () => {});
  await act(async () => root.render(createElement(ManagerBreakDialog, {
    board: "caja", employeeId: "example", name: "Example", managerToken: "synthetic", locale,
    onClose, onSaved, onDenied, ...(exit ? { onExit } : {}),
  })));
  const click = async (id: string) => { await act(async () => {
    const button = host.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);
    expect(button).not.toBeNull(); button!.click();
  }); };
  return { host, root, click, onClose, onExit, onSaved, onDenied };
}
afterEach(async () => {
  await act(async () => { for (const root of roots.splice(0)) root.unmount(); });
  vi.unstubAllGlobals(); document.body.innerHTML = "";
});

describe("BREAK dialog exits and localized controls", () => {
  for (const locale of ["es", "en"] as const) {
    it(`${locale}: Back dismisses one phase; Close has a separate board-exit callback`, async () => {
      vi.stubGlobal("fetch", vi.fn(async () => Response.json(pending)));
      const back = await mount(locale);
      expect(back.host.querySelector('[data-testid="descanso-back"]')?.textContent).toBe(locale === "es" ? "Atrás" : "Back");
      expect(back.host.querySelector('[data-testid="descanso-clear"]')?.textContent).toBe(locale === "es" ? "Rechazar solicitud" : "Reject request");
      expect(back.host.textContent).toContain(locale === "es" ? "One y Two" : "One and Two");
      await back.click("descanso-back");
      expect(back.onClose).toHaveBeenCalledTimes(1); expect(back.onExit).not.toHaveBeenCalled();
      const close = await mount(locale);
      expect(close.host.querySelector('[data-testid="descanso-close"]')?.textContent).toBe(locale === "es" ? "Cerrar · Volver al tablero" : "Close · Back to board");
      await close.click("descanso-close");
      expect(close.onExit).toHaveBeenCalledTimes(1); expect(close.onClose).not.toHaveBeenCalled();
    });
    it(`${locale}: disabled slots and reservation buttons use localized generic copy`, async () => {
      vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ...pending, pending: null, state: "absent", covers: [],
        shifts: [{ startAt, endAt: "2026-09-30T20:00:00.000Z" }], slots: [{ ...slot, board: "caja", approval: "automatic" }] })));
      const dialog = await mount(locale);
      const disabled = [...dialog.host.querySelectorAll<HTMLButtonElement>('[data-testid="descanso-start"]:disabled')];
      expect(disabled.length).toBeGreaterThan(0);
      for (const button of disabled) expect(button.textContent).toContain(locale === "es" ? "No disponible" : "Unavailable");
      expect(dialog.host.textContent).not.toMatch(/Fuera|mandatory|obligatori/);
      await dialog.click("descanso-start");
      expect(dialog.host.querySelector('[data-testid="descanso-start-back"]')?.textContent).toBe(locale === "es" ? "Otro inicio" : "Different start");
      expect(dialog.host.querySelector('[data-testid="descanso-save"]')?.textContent).toContain(locale === "es" ? "RESERVAR" : "RESERVE");
      await dialog.click("descanso-back");
      expect(dialog.host.querySelector('[data-testid="descanso-start"]')).not.toBeNull();
      expect(dialog.onClose).not.toHaveBeenCalled(); expect(dialog.onExit).not.toHaveBeenCalled();
    });
  }
  it("Pintar's ordinary Close and successful save still dismiss only the dialog", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => Response.json(init?.method ? { waiting: false } : pending)));
    const close = await mount("en", false);
    expect(close.host.querySelector('[data-testid="descanso-close"]')?.textContent).toBe("Close");
    await close.click("descanso-close"); expect(close.onClose).toHaveBeenCalledTimes(1);
    const save = await mount("en", false);
    await save.click("descanso-cover");
    expect(save.onSaved).toHaveBeenCalledTimes(1); expect(save.onClose).toHaveBeenCalledTimes(1);
    expect(save.onExit).not.toHaveBeenCalled();
  });
});

describe("closed dialog ignores delayed mutation completion", () => {
  for (const action of ["cover", "replace", "reject"] as const) {
    for (const result of ["success", "waiting", "denied", "failure"] as const) {
      it(`${action}: ${result} after Close cannot refresh, dismiss again or revoke another session`, async () => {
        const held = deferred<Response>();
        vi.stubGlobal("fetch", vi.fn(async (_url, init) => init?.method ? held.promise : Response.json(action === "replace" ? { ...pending, pending: null, saved: slot, auto: true } : pending)));
        const dialog = await mount("en");
        await dialog.click(action === "reject" ? "descanso-clear" : "descanso-cover");
        await dialog.click("descanso-close");
        await act(async () => {
          if (result === "failure") held.reject(new Error("offline"));
          else held.resolve(Response.json({ waiting: result === "waiting" }, { status: result === "denied" ? 403 : 200 }));
        });
        expect(dialog.onExit).toHaveBeenCalledTimes(1);
        expect(dialog.onClose).not.toHaveBeenCalled(); expect(dialog.onSaved).not.toHaveBeenCalled(); expect(dialog.onDenied).not.toHaveBeenCalled();
        expect(dialog.host.querySelector('[role="alert"]')).toBeNull();
      });
    }
  }
  it("Close while parsing mutation JSON prevents later callbacks", async () => {
    const body = deferred<unknown>();
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => init?.method ? { status: 200, ok: true, json: () => body.promise } : Response.json(pending)));
    const dialog = await mount("en");
    await dialog.click("descanso-cover"); await dialog.click("descanso-close");
    await act(async () => body.resolve({ waiting: false }));
    expect(dialog.onSaved).not.toHaveBeenCalled(); expect(dialog.onClose).not.toHaveBeenCalled();
  });
  it("Close while the saved callback is pending prevents a second dismissal", async () => {
    const saved = deferred<void>();
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => Response.json(init?.method ? {} : pending)));
    const dialog = await mount("en"); dialog.onSaved.mockImplementation(() => saved.promise);
    await dialog.click("descanso-cover"); expect(dialog.onSaved).toHaveBeenCalledTimes(1);
    await dialog.click("descanso-close");
    await act(async () => saved.resolve());
    expect(dialog.onClose).not.toHaveBeenCalled(); expect(dialog.onExit).toHaveBeenCalledTimes(1);
  });
  it("Back and unmount also invalidate pending mutations", async () => {
    for (const exit of ["back", "unmount"]) {
      const held = deferred<Response>();
      vi.stubGlobal("fetch", vi.fn(async (_url, init) => init?.method ? held.promise : Response.json(pending)));
      const dialog = await mount("es"); await dialog.click("descanso-cover");
      if (exit === "back") await dialog.click("descanso-back");
      else await act(async () => dialog.root.unmount());
      await act(async () => held.resolve(Response.json({ waiting: false })));
      expect(dialog.onSaved).not.toHaveBeenCalled(); expect(dialog.onClose).toHaveBeenCalledTimes(exit === "back" ? 1 : 0);
    }
  });
});

it("marks the chosen cover during a pending save and keeps ended distinct from rejection", async () => {
  const held = deferred<Response>();
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => init?.method ? held.promise : Response.json(pending)));
  const dialog = await mount("es");
  await dialog.click("descanso-cover");
  const selected = dialog.host.querySelector('[data-testid="descanso-cover"][aria-pressed="true"]');
  expect(selected?.textContent).toContain("Example Cover");
  expect(selected?.textContent).toContain("Guardando");
  expect(dialog.host.textContent).toContain("Mezclar");
  expect(dialog.host.textContent).not.toContain("Shuffle");
  await act(async () => held.resolve(Response.json({ error: "Unavailable" }, { status: 400 })));
  expect(dialog.host.querySelector('[aria-pressed="true"]')).toBeNull();
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ...pending, pending: null, state: "ended", approval: null, covers: [] })));
  const ended = await mount("es");
  expect(ended.host.querySelector('[data-testid="descanso-status"]')?.textContent).toContain("Solicitud finalizada sin BREAK");
  expect(ended.host.textContent).not.toMatch(/Rechazad|Completado/);
});

const alternativePending = { ...pending, covers: [], pendingRevision: { id: "pending-example", updatedAt: startAt },
  alternatives: [{ startAt: "2026-09-30T20:00:00.000Z", endAt: "2026-09-30T20:30:00.000Z", board: "caja", approval: "automatic", cover: null }] };
describe("alternative and recheck lifetime", () => {
  for (const action of ["alternative", "recheck"] as const) {
    for (const exit of ["back", "close"] as const) {
      it(`${action}: delayed response after ${exit} cannot restore state or run callbacks`, async () => {
        const held = deferred<Response>(); let calls = 0;
        const fetcher = vi.fn(async () => ++calls === 1 ? Response.json(alternativePending) : held.promise);
        vi.stubGlobal("fetch", fetcher);
        const dialog = await mount("en");
        await dialog.click(`descanso-${action}`);
        if (action === "alternative") {
          const payload = JSON.parse((fetcher.mock.calls[1] as unknown as [string, RequestInit])[1].body as string);
          expect(payload.resolvePending).toEqual(alternativePending.pendingRevision);
          expect(payload.endAt).toBe(alternativePending.alternatives[0].endAt);
        }
        await dialog.click(`descanso-${exit}`);
        await act(async () => held.resolve(Response.json(action === "alternative" ? { waiting: false } : pending)));
        expect(dialog.onSaved).not.toHaveBeenCalled(); expect(dialog.onDenied).not.toHaveBeenCalled();
        expect(dialog.onClose).toHaveBeenCalledTimes(exit === "back" ? 1 : 0);
        expect(dialog.onExit).toHaveBeenCalledTimes(exit === "close" ? 1 : 0);
        expect(dialog.host.querySelectorAll('[data-testid="descanso-cover"]')).toHaveLength(0);
      });
    }
  }
  it("keeps a refused alternative pending and Recheck replaces the stale suggestions", async () => {
    let reads = 0;
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => init?.method
      ? Response.json({ error: "Changed since preview" }, { status: 400 })
      : Response.json(++reads === 1 ? alternativePending : { ...alternativePending, alternatives: [] })));
    const dialog = await mount("en");
    await dialog.click("descanso-alternative");
    expect(dialog.host.querySelector('[data-testid="descanso-status"]')?.textContent).toContain("Pending");
    expect(dialog.host.querySelector<HTMLButtonElement>('[data-testid="descanso-clear"]')?.disabled).toBe(false);
    expect(dialog.onSaved).not.toHaveBeenCalled();
    await dialog.click("descanso-recheck");
    expect(dialog.host.querySelector('[data-testid="descanso-alternative"]')).toBeNull();
    expect(dialog.host.textContent).toContain("The request remains pending");
  });
});
