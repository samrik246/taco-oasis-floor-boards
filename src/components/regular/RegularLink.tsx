"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { Locale } from "@/lib/i18n";
import { REGULAR_COPY } from "./regular-copy";

/** "Regulares" next to the Próximos title. Hidden unless this host serves the C3 feed. */
export function RegularLink({ locale, className }: { locale: Locale; className: string }) {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    let live = true;
    fetch("/api/upcoming/regular/status", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : { enabled: false }))
      .then((body: { enabled?: unknown }) => {
        if (live) setEnabled(body.enabled === true);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  if (!enabled) return null;
  return (
    <Link href="/next/regular" className={className} data-testid="next-regular-link">
      {REGULAR_COPY[locale].link}
    </Link>
  );
}
