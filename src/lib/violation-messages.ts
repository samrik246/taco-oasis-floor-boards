import type { Locale } from "./i18n";
import type { ViolationCode } from "./rules/types";

/**
 * Plain-sentence text for each server violation code. The floor never shows
 * a raw code like STATION_FULL — see docs/DECISIONS.md.
 */
const VIOLATION_MESSAGES: Record<Locale, Record<ViolationCode, string>> = {
  en: {
    OUT_OF_SHIFT: "This person isn't on shift for that hour.",
    STATION_FULL: "That station is already full.",
    FORBIDDEN_ABILITY: "This person can't work that station.",
    PERSON_ALREADY_ASSIGNED: "This person is already assigned that hour.",
    STATION_BOARD_MISMATCH: "That station belongs to the other board.",
    SHIFT_NOT_FOUND: "That shift couldn't be found.",
    STATION_NOT_FOUND: "That station couldn't be found.",
    ASSIGNMENT_NOT_FOUND: "That assignment couldn't be found.",
    INVALID_HOUR: "That hour isn't on the board.",
    SWAP_SAME_ASSIGNMENT: "Pick two different people to swap.",
    SHIFT_SUPERSEDED: "That shift was replaced by a newer import.",
  },
  es: {
    OUT_OF_SHIFT: "Esta persona no tiene turno a esa hora.",
    STATION_FULL: "Esa estación ya está llena.",
    FORBIDDEN_ABILITY: "Esta persona no puede trabajar esa estación.",
    PERSON_ALREADY_ASSIGNED: "Esta persona ya está asignada a esa hora.",
    STATION_BOARD_MISMATCH: "Esa estación es del otro tablero.",
    SHIFT_NOT_FOUND: "No se encontró ese turno.",
    STATION_NOT_FOUND: "No se encontró esa estación.",
    ASSIGNMENT_NOT_FOUND: "No se encontró esa asignación.",
    INVALID_HOUR: "Esa hora no está en el tablero.",
    SWAP_SAME_ASSIGNMENT: "Elige dos personas distintas para intercambiar.",
    SHIFT_SUPERSEDED:
      "Ese turno fue reemplazado por una importación más reciente.",
  },
};

// Never fall back to the raw code — an unrecognized code still reads as a
// sentence, not e.g. "SOME_NEW_CODE".
const GENERIC_VIOLATION_MESSAGE: Record<Locale, string> = {
  en: "Couldn't save. Try again.",
  es: "No se pudo guardar. Intenta de nuevo.",
};

export function violationMessage(
  locale: Locale,
  code: string,
  fallback?: string,
): string {
  const dict = VIOLATION_MESSAGES[locale] as Record<string, string>;
  return dict[code] ?? fallback ?? GENERIC_VIOLATION_MESSAGE[locale];
}
