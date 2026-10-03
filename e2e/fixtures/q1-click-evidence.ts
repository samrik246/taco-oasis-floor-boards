import type { Page } from "@playwright/test";
import { writeFileSync } from "node:fs";

/** Observe the ordinary input path without dispatching events or changing layout. */
export async function observeCellClick(page: Page, testId: string) {
  await page.evaluate(id => {
    const observations: unknown[] = [];
    const targetName = (target: EventTarget | null) => target instanceof Element
      ? target.closest("[data-testid]")?.getAttribute("data-testid") ?? target.tagName : null;
    const rect = (element: Element | null) => element?.getBoundingClientRect().toJSON() ?? null;
    const sample = (phase: string, event?: Event) => {
      const cell = document.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);
      const pointer = event instanceof MouseEvent ? { x: event.clientX, y: event.clientY, buttons: event.buttons } : null;
      observations.push({ phase, time: performance.now(), eventTarget: targetName(event?.target ?? null),
        pointer, hitTarget: pointer ? targetName(document.elementFromPoint(pointer.x, pointer.y)) : null,
        focused: targetName(document.activeElement), cell: rect(cell), disabled: cell?.disabled,
        scrollY, scrollHeight: document.documentElement.scrollHeight,
        gridScrollLeft: document.querySelector('[data-testid="q1-grid-scroll"]')?.scrollLeft,
        detail: rect(document.querySelector('[data-testid="q1-interval-detail"]')),
        detailText: document.querySelector('[data-testid="q1-interval-detail"]')?.textContent,
        selected: [...document.querySelectorAll('[data-testid^="quarter-palette-"][aria-pressed="true"]')].map(targetName),
        navigationBlocked: document.querySelector('[data-testid="quarter-hour-editor"]')?.getAttribute("data-paint-navigation-blocked"),
        saveDisabled: document.querySelector<HTMLButtonElement>('[data-testid="quarter-save"]')?.disabled,
        status: document.querySelector('[data-testid="quarter-draft-status"]')?.textContent,
        previews: [...document.querySelectorAll('[data-testid="quarter-private-preview"]')].map(el => el.getAttribute("aria-label")),
      });
    };
    const events = ["pointerdown", "pointerup", "pointercancel", "mousedown", "mouseup", "click", "focus", "focusin"];
    const listener = (event: Event) => { sample(event.type, event); requestAnimationFrame(() => sample(`${event.type}:frame`, event)); };
    events.forEach(name => document.addEventListener(name, listener, true));
    sample("before");
    Object.assign(window, { __q1ClickEvidence: { observations, stop: () => {
      events.forEach(name => document.removeEventListener(name, listener, true)); sample("after");
    } } });
  }, testId);
  return async (path: string, retained: { before: unknown; after: unknown }) => {
    const observations = await page.evaluate(() => {
      const evidence = Reflect.get(window, "__q1ClickEvidence"); evidence.stop();
      delete (window as unknown as Record<string, unknown>).__q1ClickEvidence;
      return evidence.observations;
    });
    writeFileSync(path, JSON.stringify({ testId, observations, retained }, null, 2));
  };
}
