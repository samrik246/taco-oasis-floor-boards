import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  defaultLocalePreference,
  readLocalePreference,
  saveLocalePreference,
} from "./locale-preference";

// This suite runs under vitest's node environment (no jsdom, no real
// `window` — see vitest.config.ts). A tiny in-memory localStorage stands in
// for the browser so the persistence round trip is still exercised; it is
// removed after every test so no other test file sees a leaked global
// (tests run serially — fileParallelism: false).
function installFakeWindow() {
  const store = new Map<string, string>();
  (globalThis as unknown as { window: unknown }).window = {
    localStorage: {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
    },
  };
}

function removeFakeWindow() {
  delete (globalThis as unknown as { window?: unknown }).window;
}

describe("locale preference (no window / SSR)", () => {
  it("defaults to Spanish when there is no window", () => {
    expect(readLocalePreference()).toBe("es");
    expect(defaultLocalePreference()).toBe("es");
  });

  it("save is a no-op with no window (doesn't throw)", () => {
    expect(() => saveLocalePreference("en")).not.toThrow();
  });
});

describe("locale preference (device persistence)", () => {
  beforeEach(installFakeWindow);
  afterEach(removeFakeWindow);

  it("defaults to Spanish, not board-derived, when unset", () => {
    // C2: this must hold even for what was previously the always-English
    // caja board — the default comes from here, not from localeForBoard.
    expect(readLocalePreference()).toBe("es");
  });

  it("persists a saved preference across reads (simulated reload)", () => {
    saveLocalePreference("en");
    expect(readLocalePreference()).toBe("en");
    saveLocalePreference("es");
    expect(readLocalePreference()).toBe("es");
  });

  it("falls back to the default on a corrupt stored value", () => {
    (globalThis as unknown as { window: { localStorage: Storage } }).window
      .localStorage.setItem("taco-oasis-locale-v1", "fr");
    expect(readLocalePreference()).toBe("es");
  });
});
