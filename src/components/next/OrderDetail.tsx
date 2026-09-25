import { X } from "lucide-react";
import type { Locale } from "@/lib/i18n";
import type { UpcomingOrder } from "@/lib/upcoming/fence";
import { guestsText, type NextCopy } from "./next-copy";
import { dayHeading, relativeDay, time12 } from "./format";
import { FulfillWord, UrgencyChip, fulfillBar } from "./parts";
import type { NextColumn } from "./prefs";

type Props = {
  order: UpcomingOrder;
  columns: Record<NextColumn, boolean>;
  t: NextCopy;
  locale: Locale;
  today: string;
  onClose?: () => void;
};

/** Split "1 x Beef, 1 x Corn" into one modifier per line. */
function modifierList(raw: string): string[] {
  return raw
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
}

/**
 * One order's kitchen detail, filling the screen. Renders only fenced fields.
 * Big text: 22px body, 28px item names, 32px date and time.
 */
export function OrderDetail({ order, columns, t, locale, today, onClose }: Props) {
  return (
    <section
      className="flex min-h-full flex-col gap-4 bg-white p-4 text-[22px] text-neutral-900 sm:p-6"
      data-testid="next-order-detail"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="text-[32px] font-black leading-tight">
            {dayHeading(order.event_date, today, locale)}
          </h2>
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-[32px] font-black tabular-nums">{time12(order.event_time)}</span>
            <UrgencyChip today={today} date={order.event_date} label={relativeDay(today, order.event_date, locale)} />
          </div>
        </div>
        {onClose && (
          <button
            type="button"
            className="flex min-h-14 shrink-0 items-center gap-2 rounded-lg border-2 border-neutral-900 bg-white px-5 text-[22px] font-bold"
            onClick={onClose}
            data-testid="next-detail-close"
          >
            <X aria-hidden className="size-7" />
            {t.close}
          </button>
        )}
      </div>

      <div
        className={`flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg border-l-[12px] bg-neutral-100 p-4 ${fulfillBar(order.fulfill_type)}`}
        data-testid="next-detail-band"
        data-fulfill={order.fulfill_type}
      >
        {columns.fulfill && <FulfillWord type={order.fulfill_type} t={t} />}
        {columns.ready && (
          <span className="font-semibold">
            {t.ready} <span className="font-black tabular-nums">{order.ready_time ? time12(order.ready_time) : "—"}</span>
          </span>
        )}
        {columns.guests && (
          <span className="font-semibold">
            {t.guests}{" "}
            <span className="font-black tabular-nums">
              {order.guests == null ? "—" : guestsText(order.guests, t)}
            </span>
          </span>
        )}
        <span className="ml-auto text-[20px] text-neutral-600">#{order.id_tail}</span>
      </div>

      <h3 className="text-[26px] font-black">{t.lines}</h3>
      <ul className="flex flex-col" data-testid="next-order-lines">
        {order.lines.map((line, i) => (
          <li
            key={i}
            className={`flex gap-4 rounded-lg p-3 ${i % 2 === 0 ? "bg-white" : "bg-neutral-100"}`}
          >
            <span className="flex size-14 shrink-0 items-center justify-center rounded-lg border-2 border-neutral-900 bg-white text-[28px] font-black tabular-nums">
              {line.qty}
            </span>
            <div className="flex flex-col">
              <span className="text-[28px] font-bold leading-tight">
                {line.item_name}
                {line.variation && line.variation !== "Regular" && ` [${line.variation}]`}
              </span>
              {columns.modifiers && line.modifiers && (
                <ul className="mt-1 list-disc pl-7 text-[22px] text-neutral-800">
                  {modifierList(line.modifiers).map((m, j) => (
                    <li key={j}>{m}</li>
                  ))}
                </ul>
              )}
            </div>
          </li>
        ))}
      </ul>

      {onClose && (
        <button
          type="button"
          className="mt-2 flex min-h-16 w-full items-center justify-center rounded-lg border-2 border-neutral-900 bg-neutral-900 text-[24px] font-bold text-white"
          onClick={onClose}
          data-testid="next-detail-back"
        >
          {t.backToList}
        </button>
      )}
    </section>
  );
}
