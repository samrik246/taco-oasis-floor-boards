import {
  markBorderClass,
  markFillClass,
  type SelectionMark,
} from "@/lib/selection-mark";
import { cn } from "@/lib/utils";

/**
 * Circle for a dot. The white halo sits inside the 16px slot.
 * Four slots plus 1px gaps fit one line in the 5rem hour column.
 */
export function SelectionMarkDot({
  color,
  mark,
  level,
  testId,
}: {
  color: string;
  mark: Exclude<SelectionMark, "none">;
  level: string;
  testId: string;
}) {
  const fill = mark === "filled" ? markFillClass(color) : "bg-transparent";
  return (
    <span
      className="inline-flex size-4 shrink-0 items-center justify-center"
      data-testid={testId}
      data-level={level}
      data-mark={mark}
    >
      <span
        className={cn(
          "size-3 rounded-full border-2 ring-2 ring-white",
          mark === "dashed" ? "border-dashed" : "border-solid",
          markBorderClass(color),
          fill,
        )}
      />
    </span>
  );
}
