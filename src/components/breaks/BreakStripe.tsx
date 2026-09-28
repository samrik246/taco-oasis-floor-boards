/** Thin bar on the lower edge of one hour cell. The label is the break, not the paint. */
export function BreakStripe({ label }: { label: string | null }) {
  if (!label) return null;
  return (
    <span
      className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-1 bg-neutral-950"
      data-testid="break-stripe"
      data-break={label}
    >
      <span className="absolute bottom-1 right-0 max-w-full truncate bg-white/80 px-0.5 text-[9px] font-bold leading-none text-neutral-950">
        {label}
      </span>
    </span>
  );
}
