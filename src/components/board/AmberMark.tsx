/** One amber mark. PR 3 reuses `removed-hour` for a person taken off a seat. */
export type AmberMarkKind = "empty-hour" | "removed-hour";

export function AmberMark({ kind }: { kind: AmberMarkKind }) {
  return (
    <span
      className="pointer-events-none absolute right-0.5 top-0.5 inline-block h-2.5 w-2.5 rounded-full bg-amber-500 ring-2 ring-amber-900"
      data-testid="amber-mark"
      data-amber-kind={kind}
      aria-hidden="true"
    />
  );
}
