/**
 * Opaque tarea suggestion engine.
 * UI shows people as top / next / … — never say “ranked”.
 */

import type { AbilityLevel } from "@/lib/rules/types";
import { abilitySortRank } from "@/lib/rules/abilities";
import {
  GREEN_SEAT_IDS,
  isLemonWarnTemplate,
  preferSeatForTemplate,
} from "@/lib/tareas/catalog";

export type SuggestionCandidate = {
  employeeId: string;
  displayName: string;
  /** Current color-board seat for this hour, if any */
  seatId: string | null;
  /** Ability on a representative station (or null) */
  abilityLevel: AbilityLevel | null;
  /** Soft preference boost from schedule position text */
  positionFit: number;
  /** How many working tareas they already have (lower is better) */
  activeTareaCount: number;
};

export type SuggestionSlot = {
  /** Display label only — top / next / next — never “rank” */
  label: "top" | "next";
  employeeId: string;
  displayName: string;
  seatId: string | null;
};

export type SuggestInput = {
  templateId: string;
  candidates: SuggestionCandidate[];
  /** When true, lemon on greens still appears but UI should warn */
  forceLemonOnGreens?: boolean;
};

function scoreCandidate(
  c: SuggestionCandidate,
  templateId: string,
  forceLemonOnGreens: boolean,
): number | null {
  let score = 100;
  score -= c.activeTareaCount * 12;
  score -= abilitySortRank(c.abilityLevel) * 8;
  score += c.positionFit;

  // Prefer MULTI / floaters for backlog chiles (when-slow work)
  if (templateId === "desvenar_chiles") {
    if (c.seatId === "multi" || c.seatId === null) score += 15;
    if (
      c.seatId &&
      GREEN_SEAT_IDS.includes(c.seatId as (typeof GREEN_SEAT_IDS)[number])
    ) {
      score -= 10;
    }
  }

  // Kitchen: prefer seated on preferred station
  const prefer = preferSeatForTemplate(templateId);
  if (prefer) {
    if (c.seatId === prefer) score += 25;
  }

  // Kitchen backlog when slow — prefer unseated / prepa
  if (templateId === "wipe_line" || templateId === "dish_assist") {
    if (c.seatId === null || c.seatId === "prepa") score += 12;
  }

  // Lemon on greens: still suggestable, but deprioritize unless force
  if (
    isLemonWarnTemplate(templateId) &&
    c.seatId &&
    GREEN_SEAT_IDS.includes(c.seatId as (typeof GREEN_SEAT_IDS)[number])
  ) {
    if (!forceLemonOnGreens) score -= 40;
  }

  if (c.abilityLevel === "preferred") score += 20;
  if (c.abilityLevel === "training") score -= 5;
  if (c.abilityLevel === "forbidden") return null;

  return score;
}

/**
 * Returns ordered suggestion slots (top, next, next…).
 * Opaque — callers must not expose numeric scores as “rank”.
 */
export function suggestAssignees(input: SuggestInput): SuggestionSlot[] {
  const force = input.forceLemonOnGreens === true;
  const scored = input.candidates
    .map((c) => {
      const s = scoreCandidate(c, input.templateId, force);
      return s === null ? null : { c, s };
    })
    .filter((x): x is { c: SuggestionCandidate; s: number } => x !== null)
    .sort(
      (a, b) =>
        b.s - a.s || a.c.displayName.localeCompare(b.c.displayName),
    );

  return scored.map((row, i) => ({
    label: i === 0 ? ("top" as const) : ("next" as const),
    employeeId: row.c.employeeId,
    displayName: row.c.displayName,
    seatId: row.c.seatId,
  }));
}

/** Position-string soft fit for cashiers + kitchen homework tareas */
export function positionFitFromSource(sourcePosition: string): number {
  const p = sourcePosition.toLowerCase();
  if (p.includes("manager")) return 5;
  if (p.includes("regular")) return 10;
  if (p.includes("prueba")) return 8;
  if (p.includes("nieves")) return 4;
  if (p.includes("meser")) return 3;
  if (p.includes("limpieza")) return 2;
  if (p.includes("cocina")) return 10;
  if (p.includes("fryer") || p.includes("freidora")) return 12;
  if (p.includes("tortilla")) return 12;
  if (p.includes("birria")) return 12;
  if (p.includes("taquero") || p.includes("taco")) return 12;
  if (p.includes("carne")) return 12;
  if (p.includes("prep") || p.includes("prepa")) return 10;
  return 5;
}
