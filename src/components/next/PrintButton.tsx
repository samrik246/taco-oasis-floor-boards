"use client";

import { useEffect, useRef, useState } from "react";
import { Printer } from "lucide-react";
import { managerAuthHeaders } from "@/lib/managers/auth-headers";
import type { NextCopy } from "./next-copy";

type TapResult = {
  status: "ok" | "blocked" | "uncertain" | "locked" | "busy" | "refused";
  cambio: boolean;
  problems: string[];
};

export type PrintNotice =
  | { kind: "ok" }
  | { kind: "blocked"; problems: string[] }
  | { kind: "uncertain" }
  | { kind: "busy" }
  | { kind: "refused" }
  | { kind: "managerOnly" };

type Props = {
  tail: string;
  t: NextCopy;
  /** A manager token, asking for the code first when none is held. Null = cancelled. */
  getToken: () => Promise<string | null>;
  /** The server refused the token: forget it. */
  onTokenRejected: () => void;
  /** Tails that had an uncertain send on this page; they never show the button again. */
  uncertainTails: Set<string>;
  onUncertain: (tail: string) => void;
};

/** Words for a notice. Uncertain never offers a retry. */
export function noticeText(notice: PrintNotice, t: NextCopy): string {
  switch (notice.kind) {
    case "ok":
      return t.printOk;
    case "blocked": {
      const why = notice.problems.map((p) => t.printWhy[p]).find(Boolean) ?? t.printWhy.no_response;
      return t.printBlocked(why);
    }
    case "uncertain":
      return t.printUncertain;
    case "busy":
      return t.printBusy;
    case "refused":
      return t.printRefused;
    case "managerOnly":
      return t.printManagerOnly;
  }
}

/** Pure view, so the three states render the same in tests and on the tablet. */
export function PrintButtonView({
  t,
  printed,
  busy,
  notice,
  onTap,
}: {
  t: NextCopy;
  printed: boolean;
  busy: boolean;
  notice: PrintNotice | null;
  onTap: () => void;
}) {
  const locked = notice?.kind === "uncertain";
  return (
    <div className="flex flex-col gap-2" data-testid="t4g-print">
      {notice && (
        <p
          className={`rounded-lg border-2 p-3 text-[22px] font-bold ${
            notice.kind === "ok"
              ? "border-emerald-800 bg-emerald-50 text-emerald-950"
              : "border-red-800 bg-red-50 text-red-950"
          }`}
          role={notice.kind === "ok" ? "status" : "alert"}
          data-testid="t4g-print-notice"
          data-kind={notice.kind}
        >
          {noticeText(notice, t)}
        </p>
      )}
      {!locked && (
        <button
          type="button"
          className="flex min-h-16 w-full items-center justify-center gap-3 rounded-lg border-2 border-neutral-900 bg-white text-[24px] font-bold text-neutral-900 disabled:opacity-60"
          onClick={onTap}
          disabled={busy}
          data-testid="t4g-print-button"
        >
          <Printer aria-hidden className="size-7" />
          {busy ? t.printing : printed ? t.reprint : t.print}
        </button>
      )}
    </div>
  );
}

/**
 * Imprimir in the Próximos detail. Hidden unless the host has printing on.
 * The server decides first print vs CAMBIO from its ledger; the label only
 * follows it.
 */
export function PrintButton({ tail, t, getToken, onTokenRejected, uncertainTails, onUncertain }: Props) {
  const inFlight = useRef(false);
  const [enabled, setEnabled] = useState(false);
  const [printed, setPrinted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<PrintNotice | null>(
    uncertainTails.has(tail) ? { kind: "uncertain" } : null,
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/upcoming/print?tail=${encodeURIComponent(tail)}`, { cache: "no-store" });
        if (!res.ok) return;
        const body = (await res.json()) as { printing?: boolean; printed?: boolean; locked_until?: string | null };
        if (cancelled || body.printing !== true) return;
        setEnabled(true);
        setPrinted(body.printed === true);
        if (body.locked_until) setNotice({ kind: "uncertain" });
      } catch {
        /* printing stays hidden */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tail]);

  if (!enabled) return null;

  async function tap() {
    // Lock before the asynchronous unlock as well as the send. React state alone
    // does not exclude a second tap delivered before the next render.
    if (inFlight.current || uncertainTails.has(tail) || notice?.kind === "uncertain") return;
    inFlight.current = true;
    setBusy(true);
    try {
      const token = await getToken();
      if (!token) return;
      const res = await fetch("/api/upcoming/print", {
        method: "POST",
        headers: { "content-type": "application/json", ...managerAuthHeaders(token) },
        body: JSON.stringify({ tail }),
      });
      if (res.status === 401 || res.status === 403) {
        if (res.status === 401) onTokenRejected();
        setNotice({ kind: "managerOnly" });
        return;
      }
      if (res.status === 502) {
        setNotice({ kind: "refused" });
        return;
      }
      if (!res.ok) {
        setNotice({ kind: "refused" });
        return;
      }
      const body = (await res.json()) as TapResult;
      if (body.status === "ok") {
        setPrinted(true);
        setNotice({ kind: "ok" });
      } else if (body.status === "blocked") {
        setNotice({ kind: "blocked", problems: body.problems ?? [] });
      } else if (body.status === "busy") {
        setNotice({ kind: "busy" });
      } else if (body.status === "refused") {
        setNotice({ kind: "refused" });
      } else {
        setPrinted(true);
        onUncertain(tail);
        setNotice({ kind: "uncertain" });
      }
    } catch {
      // The request may have reached the host: treat it as uncertain.
      onUncertain(tail);
      setNotice({ kind: "uncertain" });
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return <PrintButtonView t={t} printed={printed} busy={busy} notice={notice} onTap={() => void tap()} />;
}
