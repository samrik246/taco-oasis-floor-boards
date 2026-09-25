import { ChevronRight, Store, Truck } from "lucide-react";
import type { Locale } from "@/lib/i18n";
import type { FulfillType, UpcomingOrder } from "@/lib/upcoming/fence";
import { guestsText, type NextCopy } from "./next-copy";
import { relativeDay, time12, urgency } from "./format";
import type { NextColumn } from "./prefs";

/**
 * Shared NEXT pieces. Color always follows the fulfill type or the day, and
 * the word is always printed beside it: color never carries meaning alone.
 */

export function fulfillBar(type: FulfillType): string {
  return type === "DELIVERY" ? "border-l-blue-700" : "border-l-green-700";
}

function fulfillInk(type: FulfillType): string {
  return type === "DELIVERY" ? "text-blue-800" : "text-green-800";
}

export function FulfillWord({ type, t }: { type: FulfillType; t: NextCopy }) {
  const Icon = type === "DELIVERY" ? Truck : Store;
  return (
    <span
      className={`inline-flex items-center gap-2 font-black ${fulfillInk(type)}`}
      data-testid="next-fulfill-word"
      data-fulfill={type}
    >
      <Icon aria-hidden className="size-7" />
      {t.fulfillType[type]}
    </span>
  );
}

const URGENCY_CLASS = {
  today: "border-red-700 bg-red-50 text-red-800",
  tomorrow: "border-amber-700 bg-amber-50 text-amber-900",
  later: "border-neutral-400 bg-white text-neutral-800",
} as const;

export function UrgencyChip({ today, date, label }: { today: string; date: string; label: string }) {
  const u = urgency(today, date);
  return (
    <span
      className={`inline-flex items-center rounded-full border-2 px-3 py-0.5 text-[20px] font-black ${URGENCY_CLASS[u]}`}
      data-testid="next-urgency"
      data-urgency={u}
    >
      {label}
    </span>
  );
}

/** One order as a big tappable card (list and week views). */
export function OrderCard({
  order,
  t,
  locale,
  today,
  columns,
  zebra,
  onOpen,
}: {
  order: UpcomingOrder;
  t: NextCopy;
  locale: Locale;
  today: string;
  columns: Record<NextColumn, boolean>;
  zebra: boolean;
  onOpen: (o: UpcomingOrder) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onOpen(order)}
      className={`flex min-h-14 w-full items-center gap-3 rounded-lg border-2 border-l-[12px] border-neutral-300 p-4 text-left text-[22px] text-neutral-900 ${fulfillBar(order.fulfill_type)} ${
        zebra ? "bg-neutral-100" : "bg-white"
      }`}
      data-testid={`next-card-${order.id_tail}`}
      data-fulfill={order.fulfill_type}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <span className="text-[32px] font-black tabular-nums leading-none">{time12(order.event_time)}</span>
          <UrgencyChip today={today} date={order.event_date} label={relativeDay(today, order.event_date, locale)} />
          {columns.fulfill && <FulfillWord type={order.fulfill_type} t={t} />}
        </div>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1 font-semibold">
          {columns.guests && order.guests != null && (
            <span>
              {t.guests} <span className="font-black">{guestsText(order.guests, t)}</span>
            </span>
          )}
          {columns.ready && order.ready_time && (
            <span>
              {t.ready} <span className="font-black tabular-nums">{time12(order.ready_time)}</span>
            </span>
          )}
          <span>{t.lineCount(order.lines.length)}</span>
        </div>
      </div>
      <span className="shrink-0 text-[20px] text-neutral-600">#{order.id_tail}</span>
      <ChevronRight aria-hidden className="size-8 shrink-0 text-neutral-700" />
    </button>
  );
}
