import type { NextCopy } from "./next-copy";

/**
 * Staff words for one T4G order on the floor board.
 * The order code is not part of this string.
 * Part B: when the fence allows `first_name`, that field leads the label.
 * This function already reads it. The fence does not accept it yet.
 */
export function stripOrderLabel(
  order: {
    event_time: string;
    ready_time: string | null;
    guests: number | null;
    first_name?: string | null;
  },
  t: NextCopy,
): string {
  const name = order.first_name?.trim() ?? "";
  const when = order.ready_time
    ? `${t.stripReady} ${order.ready_time}`
    : `${t.eventTime} ${order.event_time}`;
  const parts = [name, when];
  if (order.guests != null) parts.push(t.peopleCount(order.guests));
  return parts.filter((part) => part.length > 0).join(" · ");
}
