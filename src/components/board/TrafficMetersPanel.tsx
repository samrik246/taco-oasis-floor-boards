"use client";

import { cn } from "@/lib/utils";
import type { BusynessLevel } from "@/lib/load-stations";
import {
  busynessLabel,
  loadStationLabel,
  type Locale,
  type Messages,
} from "@/lib/i18n";

export type TrafficMeterDto = {
  loadStationId: string;
  label: string;
  level: BusynessLevel;
  orderCount: number;
  seatIds: readonly string[];
  board?: string;
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
  /** Training switch is manager-only. */
  canToggle: boolean;
  onToggle: (enabled: boolean) => void;
  compact?: boolean;
  locale: Locale;
  t: Messages;
};

export function TrafficMetersPanel({
  traffic,
  readonly,
  canToggle,
  onToggle,
  compact,
  locale,
  t,
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
        <h2 className="text-lg font-bold">{t.orderTraffic}</h2>
        <label className="flex min-h-11 items-center gap-2 text-sm font-semibold">
          <input
            type="checkbox"
            className="size-5 accent-neutral-900"
            checked={traffic?.enabled ?? false}
            disabled={readonly || !canToggle}
            title={canToggle ? undefined : t.managerOnly}
            onChange={(e) => onToggle(e.target.checked)}
            data-testid="traffic-toggle"
          />
          {t.simulator}
        </label>
      </div>
      <p className="mb-3 text-xs font-medium text-neutral-600">{t.trafficHint}</p>
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
            <div className="text-sm font-extrabold">
              {loadStationLabel(locale, m.loadStationId, m.label)}
            </div>
            <div className="text-xs font-bold uppercase tracking-wide">
              {busynessLabel(locale, m.level)}
            </div>
            <div className="text-[10px] font-medium opacity-80">
              {t.seats}: {m.seatIds.join(", ")}
            </div>
          </div>
        ))}
        {!traffic && (
          <p className="col-span-full text-sm font-medium text-neutral-600">
            {t.loadingMeters}
          </p>
        )}
      </div>
    </section>
  );
}
