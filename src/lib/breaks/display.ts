import { formatInTimeZone } from "date-fns-tz";
import { TIMEZONE } from "@/lib/constants";
import type { Locale } from "@/lib/i18n";

export type BreakArea = "caja" | "cocina";
export type Approval = "automatic" | "gerente";
export type BreakWindow = { startAt: string; endAt: string };
export type BreakOption = BreakWindow & { board: BreakArea; approval: Approval };
export type BreakStatus = BreakWindow & { board: BreakArea; state: "pending" | "reserved" | "on-break" | "completed" | "ended"; approval: Approval | null };
export type BreakTimeline = {
  date: string; asOf: string; gerenteAvailable: boolean;
  people: { id: string; name: string; shifts: (BreakWindow & { board: BreakArea })[] }[];
  breaks: (BreakStatus & { id: string; employeeId: string; firstName: string; status: string })[];
};
export function breakClock(iso: string) { return formatInTimeZone(new Date(iso), TIMEZONE, "h:mm a"); }
export function breakRange(slot: BreakWindow) { return `${breakClock(slot.startAt)} – ${breakClock(slot.endAt)}`; }
export function approvalLine(locale: Locale, approval: Approval, slot = false) {
  if (locale === "es") return slot
    ? approval === "automatic" ? "Disponible · Aprobación automática" : "Disponible · Requiere aprobación del gerente"
    : approval === "automatic" ? "Aprobación: automática." : "Aprobación: requiere gerente.";
  return slot
    ? approval === "automatic" ? "Available · Automatic approval" : "Available · Gerente approval required"
    : approval === "automatic" ? "Approval: automatic." : "Approval: gerente required.";
}
export function stateLabel(locale: Locale, state: BreakStatus["state"] | "absent") {
  const labels = {
    es: { absent: "Sin BREAK", pending: "Pendiente", reserved: "Reservado", "on-break": "En BREAK", completed: "Completado", ended: "Solicitud finalizada sin BREAK" },
    en: { absent: "No BREAK", pending: "Pending", reserved: "Reserved", "on-break": "On BREAK", completed: "Completed", ended: "Request ended without a BREAK" },
  };
  return labels[locale][state];
}
export const statusClass = {
  pending: "border-amber-700 bg-amber-50 text-amber-950",
  reserved: "border-blue-700 bg-blue-50 text-blue-950",
  "on-break": "border-green-700 bg-green-50 text-green-950",
  completed: "border-neutral-300 bg-neutral-100 text-neutral-600",
  ended: "border-neutral-300 bg-neutral-100 text-neutral-600",
};
export const breakButton = "min-h-12 rounded-xl border-2 border-neutral-800 px-4 py-2 font-bold active:bg-neutral-200 disabled:opacity-40";
