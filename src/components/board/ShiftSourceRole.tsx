import type { Locale } from "@/lib/i18n";

/** The exported role belongs to this shift, independently of its painted duty. */
export function ShiftSourceRole({ shiftId, position, locale }: { shiftId: string; position: string; locale: Locale }) {
  return <span className="block text-[10px] font-normal" data-testid={`source-role-${shiftId}`}>
    {locale === "es" ? "Rol WIW" : "WIW role"}: {position || "—"}
  </span>;
}
