"use client";

import { HomeLink } from "@/components/HomeLink";
import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { KioskLock, kioskRequested, releaseKioskLock } from "@/components/board/KioskLock";
import { boardKioskReturnHref } from "@/lib/breaks/picker-steps";
import { readLocalePreference } from "@/lib/locale-preference";
import type { Locale } from "@/lib/i18n";
import { BreakWorkspace } from "./BreakWorkspace";
export { BREAK_SAVED_MS, BREAK_IDLE_MS, BREAK_KEYPAD_IDLE_MS } from "./BreakWorkspace";

/** Retained direct URL and spare-tablet entry use the same full-width workspace. */
export function DescansosScreen() {
  const params = useSearchParams();
  const board = params.get("board") === "caja" ? "caja" : "cocina";
  const [locale, setLocale] = useState<Locale>("es");
  const [visit, setVisit] = useState(0);
  useEffect(() => { const timer = window.setTimeout(() => setLocale(readLocalePreference()), 0); return () => window.clearTimeout(timer); }, []);
  const href = boardKioskReturnHref(params.get("from"), board);
  const close = useCallback(() => {
    if (href) { releaseKioskLock(); window.location.assign(href); }
    else setVisit(v => v + 1);
  }, [href]);
  return <main className="min-h-dvh w-full bg-white"><KioskLock active={kioskRequested(params)} />{!kioskRequested(params) && <nav className="flex justify-end p-3"><HomeLink board={board} /></nav>}<BreakWorkspace key={visit} board={board} locale={locale} onClose={close} /></main>;
}
