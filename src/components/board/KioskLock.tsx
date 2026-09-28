"use client";

import { useEffect } from "react";

const RELEASE_EVENT = "color-boards-kiosk-release";

/** Lets one intentional in-app return pass the leave prompt. The back trap stays. */
export function releaseKioskLock(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(RELEASE_EVENT));
}

/**
 * Chrome Add-to-Home-Screen kiosk: fullscreen, trapped back button,
 * and a leave prompt. Active only when the page is opened with ?kiosk=1
 * or already running as an installed fullscreen app.
 */
export function KioskLock({ active }: { active: boolean }) {
  useEffect(() => {
    if (!active) return;
    let released = false;
    const release = () => {
      released = true;
    };

    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (released) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    window.addEventListener(RELEASE_EVENT, release);

    const trapBack = () => {
      window.history.pushState({ kiosk: true }, "", window.location.href);
    };
    trapBack();
    window.addEventListener("popstate", trapBack);

    const enterFullscreen = () => {
      const root = document.documentElement;
      if (!document.fullscreenElement && root.requestFullscreen) {
        void root.requestFullscreen().catch(() => {
          /* iOS / already denied — the installed app is still fullscreen */
        });
      }
    };
    window.addEventListener("pointerdown", enterFullscreen);

    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      window.removeEventListener(RELEASE_EVENT, release);
      window.removeEventListener("popstate", trapBack);
      window.removeEventListener("pointerdown", enterFullscreen);
    };
  }, [active]);

  return null;
}

export function kioskRequested(
  params: { get: (name: string) => string | null },
): boolean {
  const flag = params.get("kiosk");
  if (flag === "1" || flag === "true") return true;
  if (typeof window === "undefined") return false;
  return window.matchMedia("(display-mode: fullscreen)").matches;
}
