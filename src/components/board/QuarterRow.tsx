import type { QuarterView } from "@/lib/slices/day-slices";

/** Clock labels for the open quarters of one hour. Seated and off quarters stay blank. */
export function QuarterRow({ quarters }: { quarters: readonly QuarterView[] }) {
  const open = quarters.some((quarter) => quarter.kind === "open");
  if (!open) return null;
  return (
    <span className="mt-0.5 flex justify-center gap-0.5" data-testid="quarter-row">
      {quarters.map((quarter, index) => (
        <span
          key={index}
          data-quarter={quarter.kind}
          className={quarter.kind === "open" ? "text-[9px] font-black leading-3" : "sr-only"}
        >
          {quarter.kind === "open" ? quarter.label : ""}
        </span>
      ))}
    </span>
  );
}
