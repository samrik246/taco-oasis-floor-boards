/** Plain Spanish lines. Elliot's D2 fold 8 is the source of these words. */
export const BREAK_REFUSAL_TEXT: Record<string, string> = {
  ALIGNMENT: "Elige un cuarto de hora.",
  DURATION: "El BREAK va en pasos de 15 minutos.",
  OUTSIDE_SHIFT: "Ese horario queda fuera de tu turno.",
  OTHER_BOARD: "Ese horario no es de esta área.",
  ALLOWANCE: "Eso pasa de tus minutos.",
  BLACKOUT: "Ese horario está bloqueado.",
  CEILING: "Ya hay dos personas en BREAK.",
  EMPTY_STAR: "Falta una posición obligatoria. Pide ayuda a un gerente.",
  STAR_COUNT: "No hay suficiente gente en ese horario.",
  NEEDS_COVER: "Un gerente tiene que nombrar quién te cubre.",
  BAD_COVER: "Esa persona no puede cubrir.",
  LOCK_CONFLICT: "Otro compañero acaba de tomar ese horario, elige otro.",
  NOT_FOUND: "No encontramos tu turno. Pide ayuda a un gerente.",
  BOARD_MISMATCH: "Ese BREAK es de la otra área. Pide ayuda a un gerente.",
};

export const BREAK_WRONG_CODE = "Ese código no coincide.";
export const BREAK_COLLISION = "Código repetido, pide ayuda a un gerente";
export const BREAK_PAUSE = "Espera 1 minuto";
export const BREAK_PAUSE_READY = "Ya puedes intentar";
export const BREAK_QUARTER_BLOCKED = "Bloqueado";
export const BREAK_QUARTER_TAKEN = "Ocupado";
export const BREAK_QUARTER_OUTSIDE = "Fuera";
export const BREAK_UNCONFIGURED = "BREAK no configurado";
export const BREAK_EXPIRED = "Se acabó el tiempo. Entra otra vez.";

/** Tablet line when the five-minute pick names a cover. */
export function breakCoverToldLine(coverName: string, personName: string): string {
  return `${coverName} cubre a ${personName}.`;
}

/** Tablet line when a rolled break no longer fits. */
export function breakRolledEndedLine(personName: string): string {
  return `El BREAK de ${personName} ya no cabe.`;
}

export const BREAK_LOG_ACTOR = { id: "break", name: "Descansos" } as const;

/** Manager dialog only. Unlisted codes keep the staff line. */
export const MANAGER_BREAK_TEXT: Record<string, string> = {
  ...BREAK_REFUSAL_TEXT,
  OUTSIDE_SHIFT: "Ese horario queda fuera de su turno.",
  ALLOWANCE: "Eso pasa de sus minutos.",
  BOARD_MISMATCH: "Ese BREAK es de la otra área.",
  NOT_FOUND: "No encontramos a esta persona.",
};
