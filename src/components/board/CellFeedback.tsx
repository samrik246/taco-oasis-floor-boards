"use client";

import { useLayoutEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** Outside the grid's overflow/stacking context; follows its cell without changing row geometry. */
export function CellFeedback({ anchorId, testId, children }: { anchorId: string; testId: string; children: ReactNode }) {
  const popup = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const panel = popup.current;
    if (!panel) return;
    const place = () => {
      const anchor = document.getElementById(anchorId);
      const viewport = window.visualViewport;
      const leftEdge = (viewport?.offsetLeft ?? 0) + 8;
      const viewportTop = (viewport?.offsetTop ?? 0) + 8;
      const bottomEdge = viewportTop + (viewport?.height ?? window.innerHeight) - 16;
      const toolbarBottom = document.querySelector('[data-testid="floor-board"] > header')?.getBoundingClientRect().bottom ?? 0;
      const topEdge = Math.max(viewportTop, Math.min(toolbarBottom + 8, bottomEdge - 60));
      const width = (viewport?.width ?? window.innerWidth) - 16, height = bottomEdge - topEdge;
      panel.style.maxWidth = `${Math.max(0, width)}px`;
      panel.style.maxHeight = `${Math.max(0, height)}px`;
      const rect = anchor?.getBoundingClientRect();
      const box = panel.getBoundingClientRect();
      const below = (rect?.bottom ?? topEdge) + 4;
      const top = below + box.height <= topEdge + height ? below : (rect?.top ?? topEdge) - box.height - 4;
      panel.style.left = `${Math.max(leftEdge, Math.min(rect?.left ?? leftEdge, leftEdge + width - box.width))}px`;
      panel.style.top = `${Math.max(topEdge, Math.min(top, topEdge + height - box.height))}px`;
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(panel);
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    window.visualViewport?.addEventListener("resize", place);
    window.visualViewport?.addEventListener("scroll", place);
    return () => {
      observer.disconnect();
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
      window.visualViewport?.removeEventListener("resize", place);
      window.visualViewport?.removeEventListener("scroll", place);
    };
  }, [anchorId, children]);
  return createPortal(<div ref={popup} id={`${testId}-message`} role="alert" data-testid={testId} className="fixed z-40 w-80 overflow-auto rounded border-2 border-amber-800 bg-amber-50 p-2 text-sm text-amber-950 shadow-lg">{children}</div>, document.body);
}
