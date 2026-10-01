import type { Document, Observation, Status } from "@/lib/receipts/protocol";
export type ReceiptLocale = "es" | "en";
export const words = (locale: ReceiptLocale, es: string, en: string) => locale === "es" ? es : en;

const STATUS: Record<Status["display_code"], [string, string]> = {
  ready: ["Sin avisos · respuesta reciente", "No warnings · recent response"],
  stale: ["Estado anterior · consultar de nuevo", "Previous status · check again"],
  unknown: ["Estado desconocido", "Status unknown"],
  busy: ["No se consultó · otra operación en curso", "Not checked · another operation is active"],
  rate_limited: ["No se consultó · espera un momento", "Not checked · wait a moment"],
  identity_mismatch: ["Impresora distinta", "Different printer"],
  identity_unknown: ["No se pudo identificar", "Could not identify printer"],
  no_response: ["Sin respuesta", "No response"],
  query_unavailable: ["Consulta no disponible", "Status check unavailable"],
  paper_out: ["Sin papel", "Out of paper"],
  cover_open: ["Tapa abierta", "Cover open"],
  printer_fault: ["Revisar impresora", "Check printer"],
  paper_warning: ["Revisar papel", "Check paper"],
};
const DOCUMENT: Record<Document["state"], [string, string]> = {
  prepared: ["Preparado · sin enviar", "Prepared · not sent"],
  refused: ["Intento detenido antes del envío", "Attempt stopped before sending"],
  not_attempted: ["No se intentó enviar", "Not attempted"],
  in_flight: ["Envío en curso", "Sending"],
  transmitted: ["Enviado · papel por revisar", "Sent · check paper"],
  uncertain: ["Resultado sin confirmar", "Result unconfirmed"],
};
export function statusText(status: Status | undefined, locale: ReceiptLocale, now: number) {
  let key = status?.display_code ?? "unknown";
  if (status?.last_outcome === "valid" && status.last_valid && now >= Date.parse(status.last_valid.expires_at) && ["ready", "paper_out", "cover_open", "printer_fault", "paper_warning"].includes(key)) key = "stale";
  return STATUS[key][locale === "es" ? 0 : 1];
}
export function documentText(state: Document["state"], locale: ReceiptLocale) { return DOCUMENT[state][locale === "es" ? 0 : 1]; }
export const OBSERVATION_COPY: Record<Observation, [string, string]> = {
  accepted: ["Salió completo y legible", "Complete and legible"],
  not_seen: ["No vi salir papel", "I did not see paper"],
  partial: ["Salió incompleto o con error", "Incomplete or incorrect"],
  duplicate: ["Salió más de una copia", "More than one copy"],
  pending: ["Todavía no lo he revisado", "Not checked yet"],
};
