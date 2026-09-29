/** Plain Spanish lines. Elliot's D2 fold 8 is the source of these words. */
export const BREAK_REFUSAL_TEXT: Record<string, string> = {
  ALIGNMENT: "Elige un cuarto de hora.",
  DURATION: "El descanso va en pasos de 15 minutos.",
  OUTSIDE_SHIFT: "Ese horario queda fuera de tu turno.",
  OTHER_BOARD: "Ese horario no es de esta área.",
  ALLOWANCE: "Eso pasa de tus minutos.",
  BLACKOUT: "Ese horario está bloqueado.",
  CEILING: "Ya hay dos personas en descanso.",
  LOCK_CONFLICT: "Otro compañero acaba de tomar ese horario, elige otro.",
  NOT_FOUND: "No encontramos tu turno. Pide ayuda a un gerente.",
  BOARD_MISMATCH: "Ese descanso es de la otra área. Pide ayuda a un gerente.",
};

export const BREAK_WRONG_CODE = "Ese código no coincide.";
export const BREAK_COLLISION = "Código repetido, pide ayuda a un gerente";
export const BREAK_PAUSE = "Espera 1 minuto";
export const BREAK_PAUSE_READY = "Ya puedes intentar";
export const BREAK_QUARTER_BLOCKED = "Bloqueado";
export const BREAK_QUARTER_TAKEN = "Ocupado";
export const BREAK_QUARTER_OUTSIDE = "Fuera";
export const BREAK_UNCONFIGURED = "Descansos no configurado";
export const BREAK_EXPIRED = "Se acabó el tiempo. Entra otra vez.";

export const BREAK_LOG_ACTOR = { id: "break", name: "Descansos" } as const;

/** Manager dialog only. Unlisted codes keep the staff line. */
export const MANAGER_BREAK_TEXT: Record<string, string> = {
  ...BREAK_REFUSAL_TEXT,
  OUTSIDE_SHIFT: "Ese horario queda fuera de su turno.",
  ALLOWANCE: "Eso pasa de sus minutos.",
  BOARD_MISMATCH: "Ese descanso es de la otra área.",
  NOT_FOUND: "No encontramos a esta persona.",
};
