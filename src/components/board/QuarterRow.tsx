import type { QuarterView } from "@/lib/slices/day-slices";

function quarterText(quarter: QuarterView): string {
  if (quarter.kind === "break") return "BREAK";
  if (quarter.auto) return "auto";
  if (quarter.kind === "open") return quarter.label;
  return "";
}

/** Clock labels for open quarters. BREAK and auto stay English on the moved or resting quarter. */
export function QuarterRow({ quarters }: { quarters: readonly QuarterView[] }) {
  const visible = quarters.some((quarter) => quarterText(quarter) !== "");
  if (!visible) return null;
  return (
    <span className="mt-0.5 flex justify-center gap-0.5" data-testid="quarter-row">
      {quarters.map((quarter, index) => {
        const text = quarterText(quarter);
        return (
          <span
            key={index}
            data-quarter={quarter.kind}
            data-auto={quarter.auto ? "1" : "0"}
            className={text ? "text-[9px] font-black leading-3" : "sr-only"}
          >
            {text}
          </span>
        );
      })}
    </span>
  );
}
