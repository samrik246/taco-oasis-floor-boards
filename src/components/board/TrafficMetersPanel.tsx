"use client";

import { cn } from "@/lib/utils";
import type { BusynessLevel, LoadStationId } from "@/lib/load-stations";

export type TrafficMeterDto = {
  loadStationId: LoadStationId;
  label: string;
  level: BusynessLevel;
  orderCount: number;
  seatIds: readonly string[];
};

export type TrafficStateDto = {
  enabled: boolean;
  lastTickAt: string | null;
  meters: TrafficMeterDto[];
};

const LEVEL_STYLE: Record<BusynessLevel, string> = {
  quiet: "border-emerald-800 bg-emerald-100 text-emerald-950",
  busy: "border-amber-800 bg-amber-100 text-amber-950",
  slammed: "border-red-900 bg-red-200 text-red-950",
};

type Props = {
  traffic: TrafficStateDto | null;
  readonly: boolean;
  onToggle: (enabled: boolean) => void;
  compact?: boolean;
};

export function TrafficMetersPanel({
  traffic,
  readonly,
  onToggle,
  compact,
}: Props) {
  return (
    <section
      className={cn(
        "rounded-lg border-2 border-neutral-900 bg-white p-3",
        compact && "p-2",
      )}
      data-testid="traffic-meters"
    >
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-bold">Order traffic</h2>
        <label className="flex min-h-11 items-center gap-2 text-sm font-semibold">
          <input
            type="checkbox"
            className="size-5 accent-neutral-900"
            checked={traffic?.enabled ?? false}
            disabled={readonly}
            onChange={(e) => onToggle(e.target.checked)}
            data-testid="traffic-toggle"
          />
          Simulator
        </label>
      </div>
      <p className="mb-3 text-xs font-medium text-neutral-600">
        Fake feed every 15s — Quiet / Busy / Slammed. Not a real POS feed.
      </p>
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        {(traffic?.meters ?? []).map((m) => (
          <div
            key={m.loadStationId}
            data-testid={`meter-${m.loadStationId}`}
            data-level={m.level}
            className={cn(
              "min-h-16 rounded-md border-2 px-2 py-2",
              LEVEL_STYLE[m.level],
            )}
          >
            <div className="text-sm font-extrabold">{m.label}</div>
            <div className="text-xs font-bold uppercase tracking-wide">
              {m.level}
            </div>
            <div className="text-[10px] font-medium opacity-80">
              seats: {m.seatIds.join(", ")}
            </div>
          </div>
        ))}
        {!traffic && (
          <p className="col-span-full text-sm font-medium text-neutral-600">
            Loading meters…
          </p>
        )}
      </div>
    </section>
  );
}
