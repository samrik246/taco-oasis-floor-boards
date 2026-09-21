"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type ManagerSession = {
  id: string;
  name: string;
};

type Options = {
  idleMs: number;
  onIdle: () => void;
  active: boolean;
};

/**
 * Tracks manager session idle timeout. Any pointer/keyboard/touch resets the timer.
 */
export function useManagerIdle({ idleMs, onIdle, active }: Options) {
  const onIdleRef = useRef(onIdle);
  onIdleRef.current = onIdle;

  useEffect(() => {
    if (!active) return;

    let timer: number | undefined;

    const reset = () => {
      if (timer != null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        onIdleRef.current();
      }, idleMs);
    };

    const events: (keyof WindowEventMap)[] = [
      "pointerdown",
      "pointermove",
      "keydown",
      "touchstart",
      "wheel",
    ];

    reset();
    for (const ev of events) {
      window.addEventListener(ev, reset, { passive: true });
    }

    return () => {
      if (timer != null) window.clearTimeout(timer);
      for (const ev of events) {
        window.removeEventListener(ev, reset);
      }
    };
  }, [active, idleMs]);
}

export function useManagerConfigIdleMs(): number {
  const [idleMs, setIdleMs] = useState(15_000);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/managers");
        if (!res.ok) return;
        const data = (await res.json()) as { idleMs?: number };
        if (!cancelled && typeof data.idleMs === "number") {
          setIdleMs(data.idleMs);
        }
      } catch {
        /* keep default */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return idleMs;
}

export function useManagerSession() {
  const [manager, setManager] = useState<ManagerSession | null>(null);
  const [idleMs, setIdleMs] = useState(15_000);
  const configIdle = useManagerConfigIdleMs();

  const unlock = useCallback(
    (session: ManagerSession, sessionIdleMs?: number) => {
      setManager(session);
      if (typeof sessionIdleMs === "number") setIdleMs(sessionIdleMs);
      else setIdleMs(configIdle);
    },
    [configIdle],
  );

  const lock = useCallback(() => {
    setManager(null);
  }, []);

  const effectiveIdle = manager ? idleMs : configIdle;

  return {
    manager,
    isManager: manager != null,
    idleMs: effectiveIdle,
    unlock,
    lock,
  };
}
