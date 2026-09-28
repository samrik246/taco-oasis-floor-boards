import {
  markBorderClass,
  markFillClass,
  type SelectionMark,
} from "@/lib/selection-mark";
import { cn } from "@/lib/utils";

/**
 * Coloured circle is size-5 (20px), twice the old size-2.5.
 * The white halo is a 2px ring inside a size-6 slot.
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
      className="inline-flex size-6 shrink-0 items-center justify-center"
      data-testid={testId}
      data-level={level}
      data-mark={mark}
    >
      <span
        className={cn(
          "size-5 rounded-full border-2 ring-2 ring-white",
          mark === "dashed" ? "border-dashed" : "border-solid",
          markBorderClass(color),
          fill,
        )}
      />
    </span>
  );
}
