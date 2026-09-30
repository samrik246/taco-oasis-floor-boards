/**
 * @vitest-environment jsdom
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ManagerBreakDialog } from "@/components/breaks/ManagerBreakDialog";

const OPEN_FAILURE = "No se pudo abrir BREAK.";

function deferred<T>() {
  let settle!: (value: T | PromiseLike<T>) => void;
  let fail!: (reason: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  return { promise, settle, fail };
}

function mount() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  return { host, root };
}

async function openDialog(root: Root) {
  await act(async () => {
    root.render(createElement(ManagerBreakDialog, {
      board: "cocina",
      employeeId: "emp-1",
      name: "Ada",
      managerToken: "tok",
      onClose: () => {},
      onSaved: async () => {},
    }));
  });
}

describe("manager break dialog load", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("shows the open failure when the request or its JSON fails", async () => {
    const network = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn(() => network.promise));
    const { host, root } = mount();
    await openDialog(root);
    expect(host.querySelector("[data-testid=descanso-message]")).toBeNull();
    await act(async () => {
      network.fail(new Error("offline"));
    });
    expect(host.querySelector("[data-testid=descanso-message]")?.textContent).toBe(OPEN_FAILURE);
    root.unmount();

    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => {
        throw new SyntaxError("bad json");
      },
    })));
    const parsed = mount();
    await openDialog(parsed.root);
    expect(parsed.host.querySelector("[data-testid=descanso-message]")?.textContent).toBe(OPEN_FAILURE);
    parsed.root.unmount();
  });

  it("leaves an unmounted dialog alone when the open settles late", async () => {
    const pending = deferred<{ ok: boolean; json: () => Promise<unknown> }>();
    vi.stubGlobal("fetch", vi.fn(() => pending.promise));
    const { host, root } = mount();
    await openDialog(root);
    await act(async () => {
      root.unmount();
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      await act(async () => {
        pending.settle({
          ok: false,
          json: async () => {
            throw new SyntaxError("late");
          },
        });
      });
      await act(async () => {
        await Promise.resolve();
      });
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    expect(unhandled).toEqual([]);
    expect(host.querySelector("[data-testid=descanso-message]")).toBeNull();
  });
});
