"use client";

import { useCallback, useEffect, useState } from "react";
import { formatInTimeZone } from "date-fns-tz";
import { useSearchParams } from "next/navigation";
import { KioskLock, kioskRequested } from "@/components/board/KioskLock";
import type { BreakNowBody, BreakNowItem } from "@/lib/breaks/now";
import { TIMEZONE } from "@/lib/constants";

const REFRESH_MS = 30_000;

function clock(iso: string): string {
  return formatInTimeZone(new Date(iso), TIMEZONE, "HH:mm");
}

function BreakList({ items, testId }: { items: BreakNowItem[]; testId: string }) {
  return (
    <ul className="space-y-2" data-testid={testId}>
      {items.map((item) => (
        <li key={`${item.firstName}-${item.startAt}-${item.endAt}`} className="text-2xl font-bold">
          {item.firstName} {clock(item.startAt)} a {clock(item.endAt)}
        </li>
      ))}
    </ul>
  );
}

/** Read-only board of who is on break and the next three. No sign-in and no links. */
export function AhoraScreen() {
  const params = useSearchParams();
  const kiosk = kioskRequested(params);
  const boardParam = params.get("board");
  const board = boardParam === "caja" || boardParam === "cocina" ? boardParam : null;
  const [body, setBody] = useState<BreakNowBody | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    if (!board) return;
    try {
      const response = await fetch(`/api/breaks/now?board=${board}`, { cache: "no-store" });
      if (!response.ok) throw new Error("breaks now failed");
      const next = await response.json() as BreakNowBody;
      setBody(next);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [board]);

  useEffect(() => {
    if (!board) return;
    const pull = () => {
      void load();
    };
    const kick = window.setTimeout(pull, 0);
    const timer = window.setInterval(pull, REFRESH_MS);
    return () => {
      window.clearTimeout(kick);
      window.clearInterval(timer);
    };
  }, [board, load]);

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-lg flex-col gap-6 bg-white p-6 text-neutral-950" data-testid="ahora">
      <KioskLock active={kiosk} />
      <h1 className="text-3xl font-bold">Ahora en descanso</h1>
      {!board && <p className="text-lg font-semibold" role="alert">Esa área no tiene descansos.</p>}
      {failed && <p className="rounded-md border-2 border-neutral-950 px-3 py-2 text-lg font-bold" role="alert" data-testid="ahora-error">No se pudo actualizar</p>}
      {body && <p className="text-lg font-semibold" data-testid="ahora-updated">actualizado {clock(body.asOf)}</p>}
      {board && body && (
        <>
          <section>
            <h2 className="text-xl font-bold">Ahora en descanso</h2>
            {body.now.length === 0
              ? <p className="mt-2 text-lg font-semibold" data-testid="ahora-now-empty">Nadie en descanso</p>
              : <BreakList items={body.now} testId="ahora-now" />}
          </section>
          <section>
            <h2 className="text-xl font-bold">Siguientes</h2>
            {body.next.length === 0
              ? <p className="mt-2 text-lg font-semibold" data-testid="ahora-next-empty">No hay más descansos hoy</p>
              : <BreakList items={body.next} testId="ahora-next" />}
          </section>
        </>
      )}
    </main>
  );
}
