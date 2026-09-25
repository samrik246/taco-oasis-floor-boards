import type { UpcomingOrder } from "@/lib/upcoming/fence";
import type { NextCopy } from "./next-copy";
import type { NextColumn } from "./prefs";

type Props = {
  order: UpcomingOrder;
  columns: Record<NextColumn, boolean>;
  t: NextCopy;
  onClose?: () => void;
};

/** One order's kitchen detail. Renders only fenced fields. */
export function OrderDetail({ order, columns, t, onClose }: Props) {
  return (
    <section
      className="flex flex-col gap-3 rounded-lg border-2 border-neutral-900 bg-white p-4"
      data-testid="next-order-detail"
    >
      <div className="flex items-start justify-between gap-3">
        <h2 className="text-xl font-black tabular-nums">#{order.id_tail}</h2>
        {onClose && (
          <button
            type="button"
            className="rounded border-2 border-neutral-900 px-3 py-1 text-sm font-bold"
            onClick={onClose}
            data-testid="next-detail-close"
          >
            {t.close}
          </button>
        )}
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-base">
        <dt className="font-semibold">{t.date}</dt>
        <dd className="tabular-nums">{order.event_date}</dd>
        <dt className="font-semibold">{t.eventTime}</dt>
        <dd className="tabular-nums">{order.event_time}</dd>
        {columns.ready && (
          <>
            <dt className="font-semibold">{t.ready}</dt>
            <dd className="tabular-nums">{order.ready_time ?? "—"}</dd>
          </>
        )}
        {columns.fulfill && (
          <>
            <dt className="font-semibold">{t.fulfill}</dt>
            <dd>{t.fulfillType[order.fulfill_type]}</dd>
          </>
        )}
        {columns.guests && (
          <>
            <dt className="font-semibold">{t.guests}</dt>
            <dd className="tabular-nums">
              {order.guests == null ? "—" : `${order.guests} (${t.confirm})`}
            </dd>
          </>
        )}
      </dl>
      <h3 className="text-base font-bold">{t.lines}</h3>
      <ul className="flex flex-col gap-1" data-testid="next-order-lines">
        {order.lines.map((line, i) => (
          <li key={i} className="border-b border-neutral-200 pb-1">
            <span className="font-bold tabular-nums">{line.qty} ×</span> {line.item_name}
            {line.variation && line.variation !== "Regular" && ` [${line.variation}]`}
            {columns.modifiers && line.modifiers && (
              <div className="text-sm text-neutral-700">{line.modifiers}</div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
