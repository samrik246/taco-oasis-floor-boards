import { expect, type Locator, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";

export async function settledFrame(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

/** Scroll the document, preserving horizontal grid position and the real toolbar. */
export async function belowToolbar(page: Page, target: Locator) {
  const measure = () => target.evaluate(el => {
    const toolbar = document.querySelector('[data-testid="floor-board"] > header')!;
    const top = el.getBoundingClientRect().top, toolbarBottom = toolbar.getBoundingClientRect().bottom;
    const max = Math.max(0, document.documentElement.scrollHeight - innerHeight);
    const y = Math.max(0, Math.min(scrollY + top - toolbarBottom - 16, max));
    return { y, delta: y - scrollY, scrollY, top, toolbarBottom, max };
  });
  const observations = [];
  // Layout may settle after a save/locator capture. Recompute from its current
  // rectangle instead of demanding a scroll offset measured before that change.
  await page.mouse.move(8, 400);
  for (let attempt = 0; attempt < 8; attempt++) {
    await settledFrame(page);
    const scroll = await measure(); observations.push(scroll);
    if (Math.abs(scroll.delta) < 1) break;
    await page.mouse.wheel(0, scroll.delta);
    await page.screenshot({ fullPage: false });
  }
  await settledFrame(page);
  const final = await measure(); observations.push(final);
  await page.evaluate(rows => Reflect.set(window, "__q1ScrollEvidence", rows), observations);
  expect(Math.abs(final.delta), JSON.stringify(observations)).toBeLessThan(1);
}

export async function visibleText(target: Locator) {
  return target.evaluate(el => {
    const box = (rect: DOMRect) => ({ x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom });
    const css = getComputedStyle(el), toolbar = document.querySelector('[data-testid="floor-board"] > header')!;
    const scroller = el.closest('[data-testid="q1-grid-scroll"]')!;
    const clip = scroller.getBoundingClientRect(), toolbarRect = toolbar.getBoundingClientRect();
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT), text = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!node.textContent?.trim()) continue;
      const range = document.createRange(); range.selectNodeContents(node);
      const style = getComputedStyle(node.parentElement!);
      for (const rect of range.getClientRects()) {
        const points = [0.1, 0.5, 0.9].map(fraction => {
          const x = rect.x + rect.width * fraction, y = rect.y + rect.height / 2;
          const top = document.elementFromPoint(x, y);
          return { x, y, unobscured: Boolean(top && el.contains(top)), top: top?.getAttribute('data-testid') ?? top?.tagName ?? null };
        });
        text.push({ text: node.textContent.trim(), rect: box(rect), color: style.color, visibility: style.visibility, opacity: style.opacity,
          inViewport: rect.x >= Math.max(0, clip.x) && rect.right <= Math.min(innerWidth, clip.right) && rect.y >= Math.max(toolbarRect.bottom, clip.y) && rect.bottom <= Math.min(innerHeight, clip.bottom), points });
      }
    }
    return { textContent: el.textContent, rect: box(el.getBoundingClientRect()), position: css.position, color: css.color, background: css.backgroundColor,
      visibility: css.visibility, opacity: css.opacity, toolbar: box(toolbarRect), scroller: box(clip), scrollX: scroller.scrollLeft, scrollY, text };
  });
}

export function expectReadable(proof: Awaited<ReturnType<typeof visibleText>>) {
  expect(proof.visibility).toBe("visible"); expect(proof.opacity).toBe("1");
  expect(proof.text.length).toBeGreaterThan(0);
  for (const fragment of proof.text) {
    expect(fragment.visibility).toBe("visible"); expect(fragment.opacity).toBe("1");
    expect(fragment.inViewport, JSON.stringify(proof)).toBe(true);
    expect(fragment.points.every(point => point.unobscured), JSON.stringify(proof)).toBe(true);
  }
}

/** No locator screenshot: it can reposition an oversized table underneath the toolbar. */
export async function viewportEvidence(page: Page, path: string, targets: Record<string, Locator>, requireReadable = true) {
  await settledFrame(page);
  const measure = async () => Object.fromEntries(await Promise.all(Object.entries(targets).map(async ([name, el]) => [name, await visibleText(el)])));
  const initial = await measure();
  let before = initial, after = initial;
  const pixels = [];
  for (let attempt = 0; attempt < 5; attempt++) {
    // Sticky layers may lag their DOM rectangles while a scroll is composited.
    // Retain the first frame and require two matching pixels before judging it.
    await settledFrame(page);
    before = await measure();
    const bytes = await page.screenshot({ path: `${path}${attempt === 0 ? ".first" : ""}.png`, fullPage: false });
    after = await measure();
    pixels.push(createHash("sha256").update(bytes).digest("hex"));
    if (attempt > 0 && pixels.at(-1) === pixels.at(-2) && JSON.stringify(before) === JSON.stringify(after)) break;
  }
  const positioning = await page.evaluate(() => Reflect.get(window, "__q1ScrollEvidence") ?? []);
  writeFileSync(`${path}.json`, JSON.stringify({ viewport: page.viewportSize(), positioning, pixels, initial, before, after }, null, 2));
  expect(pixels.at(-1), JSON.stringify(pixels)).toBe(pixels.at(-2));
  for (const key of Object.keys(before)) {
    expect(after[key]).toEqual(before[key]);
    if (requireReadable) expectReadable(after[key]);
  }
  return after;
}
