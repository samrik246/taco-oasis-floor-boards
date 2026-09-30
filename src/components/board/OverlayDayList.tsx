"use client";

import { formatInTimeZone } from "date-fns-tz";
import { managerAuthHeaders } from "@/lib/managers/auth-headers";
import { TIMEZONE } from "@/lib/constants";
import type { OverlayDto } from "@/lib/overlays/read";
import type { DayBoardDto } from "./types";

function clock(iso: string): string {
  return formatInTimeZone(new Date(iso), TIMEZONE, "HH:mm");
}

const words = {
  es: { title: "Cambios del día", switch: "Cambiar", remove: "Quitar", add: "Agregar", cancel: "Cancelar", cancelled: "Cancelado", imported: "Importación", ended: "Terminado" },
  en: { title: "Day's changes", switch: "Switch", remove: "Remove", add: "Add", cancel: "Cancel", cancelled: "Cancelled", imported: "Import", ended: "Ended" },
} as const;

function mark(row: OverlayDto, now: Date, text: { cancelled: string; imported: string; ended: string }): string | null {
  if (row.endReason === "import") return text.imported;
  if (row.endReason === "cancel" || row.cancelledAt) return text.cancelled;
  if (new Date(row.endAt).getTime() <= now.getTime()) return text.ended;
  return null;
}

export function OverlayDayList({
  day,
  board,
  date,
  locale,
  managerToken,
  onSaved,
}: {
  day: DayBoardDto;
  board: "caja" | "cocina";
  date: string;
  locale: "es" | "en";
  managerToken: string;
  onSaved: () => Promise<void>;
}) {
  const rows = day.overlays ?? [];
  if (!day.overlayMenu && rows.length === 0) return null;
  const text = words[locale];
  const now = new Date();
  const names = new Map(day.shifts.map((shift) => [shift.employee.id, shift.employee.firstName]));

  async function cancel(id: string) {
    const response = await fetch(`/api/boards/${board}/days/${date}/overlays/${id}`, {
      method: "DELETE",
      headers: managerAuthHeaders(managerToken),
    });
    if (response.ok) await onSaved();
  }

  return (
    <section className="mt-3" data-testid="overlay-list">
      <h3 className="text-sm font-bold">{text.title}</h3>
      <ul className="mt-1 space-y-1">
        {rows.map((row) => {
          const ended = mark(row, now, text);
          const who = names.get(row.employeeId) ?? row.employeeId;
          return (
            <li key={row.id} className="flex flex-wrap items-center justify-between gap-2 text-sm" data-testid={`overlay-row-${row.id}`} data-ended={ended ? "1" : "0"}>
              <span>{who} · {text[row.kind]} · {clock(row.startAt)}–{clock(row.endAt)} · {row.managerName}{ended ? ` · ${ended}` : ""}</span>
              {day.overlayMenu && !row.cancelledAt && new Date(row.endAt).getTime() > now.getTime() && (
                <button type="button" className="touch-target min-h-11 rounded-md border-2 border-neutral-900 px-2 text-xs font-bold" data-testid={`overlay-cancel-${row.id}`} onClick={() => { void cancel(row.id); }}>{text.cancel}</button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
