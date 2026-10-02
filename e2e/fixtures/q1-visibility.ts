import { expect, type Locator, type Page } from "@playwright/test";
import { writeFileSync } from "node:fs";

export async function settledFrame(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

/** Scroll the document, preserving horizontal grid position and the real toolbar. */
export async function belowToolbar(page: Page, target: Locator) {
  await target.evaluate(el => {
    const toolbar = document.querySelector('[data-testid="floor-board"] > header')!;
    window.scrollBy(0, el.getBoundingClientRect().top - toolbar.getBoundingClientRect().bottom - 16);
  });
  await settledFrame(page);
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
  const before = Object.fromEntries(await Promise.all(Object.entries(targets).map(async ([name, el]) => [name, await visibleText(el)])));
  await page.screenshot({ path: `${path}.png`, fullPage: false });
  const after = Object.fromEntries(await Promise.all(Object.entries(targets).map(async ([name, el]) => [name, await visibleText(el)])));
  writeFileSync(`${path}.json`, JSON.stringify({ viewport: page.viewportSize(), before, after }, null, 2));
  for (const key of Object.keys(before)) {
    expect(after[key]).toEqual(before[key]);
    if (requireReadable) expectReadable(after[key]);
  }
  return after;
}
