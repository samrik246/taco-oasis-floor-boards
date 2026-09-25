import type { FloorBoardId } from "@/lib/board-config";
import { ALL_STATIONS } from "@/lib/stations";
import { tareaTemplateById } from "@/lib/tareas/catalog";
import {
  LOAD_STATION_LABELS,
  MESSAGES,
  PERFORMANCE_PROMPTS,
  STATION_LABELS,
  TAREA_LABELS,
  type Locale,
  type Messages,
} from "./messages";
import type { MoveReason } from "@/lib/position-moves";
import type { AbilityLevel } from "@/lib/rules/types";

export type { Locale, Messages };
export {
  LOAD_STATION_LABELS,
  MESSAGES,
  PERFORMANCE_PROMPTS,
  STATION_LABELS,
  TAREA_LABELS,
};

/** Caja UI English; Cocina UI Spanish. */
export function localeForBoard(board: FloorBoardId): Locale {
  return board === "cocina" ? "es" : "en";
}

export function messagesFor(locale: Locale): Messages {
  return MESSAGES[locale];
}

export function stationLabel(
  locale: Locale,
  stationId: string,
  fallback?: string,
): string {
  return STATION_LABELS[locale][stationId] ?? fallback ?? stationId;
}

/**
 * Seeded stations keep the board language (cocina Spanish, caja English).
 * A label edited in the back office is shown as saved, on both boards.
 */
export function displayStationLabel(
  locale: Locale,
  station: { id: string; label: string },
): string {
  const seed = ALL_STATIONS.find((s) => s.id === station.id);
  if (!seed || station.label.trim() !== seed.label) return station.label;
  return stationLabel(locale, station.id, station.label);
}

export function displayTareaLabel(
  locale: Locale,
  template: { id: string; label: string },
): string {
  const seed = tareaTemplateById(template.id);
  if (!seed || template.label.trim() !== seed.label) return template.label;
  return tareaLabel(locale, template.id, template.label);
}

export function tareaLabel(
  locale: Locale,
  templateId: string,
  fallback?: string,
): string {
  return TAREA_LABELS[locale][templateId] ?? fallback ?? templateId;
}

export function loadStationLabel(
  locale: Locale,
  loadStationId: string,
  fallback?: string,
): string {
  return (
    LOAD_STATION_LABELS[locale][loadStationId] ?? fallback ?? loadStationId
  );
}

export function performancePrompt(
  locale: Locale,
  questionId: string,
  fallback?: string,
): string {
  return PERFORMANCE_PROMPTS[locale][questionId] ?? fallback ?? questionId;
}

export function boardDisplayName(locale: Locale, board: FloorBoardId): string {
  const t = messagesFor(locale);
  return board === "caja" ? t.cashiers : t.kitchen;
}

export function moveReasonLabel(locale: Locale, reason: MoveReason): string {
  const t = messagesFor(locale);
  switch (reason) {
    case "Break":
      return t.moveBreak;
    case "Cover expo":
      return t.moveCoverExpo;
    case "Training":
      return t.moveTraining;
    case "Help slammed":
      return t.moveHelpSlammed;
    case "Other":
      return t.moveOther;
    default:
      return reason;
  }
}

export function abilityLevelLabel(locale: Locale, level: AbilityLevel): string {
  const t = messagesFor(locale);
  switch (level) {
    case "preferred":
      return t.abilityPreferred;
    case "ok":
      return t.abilityOk;
    case "training":
      return t.abilityTraining;
    case "forbidden":
      return t.abilityForbidden;
    default:
      return level;
  }
}

export function busynessLabel(
  locale: Locale,
  level: "quiet" | "busy" | "slammed",
): string {
  const t = messagesFor(locale);
  if (level === "quiet") return t.quiet;
  if (level === "busy") return t.busy;
  return t.slammed;
}

/** Localized return-prompt message (stored English OK; display rebuilds). */
export function formatReturnPromptMessage(
  locale: Locale,
  args: {
    displayName: string;
    loadStationId: string;
    seatId: string;
    onFloater: boolean;
  },
): string {
  const load = loadStationLabel(locale, args.loadStationId);
  const seat = stationLabel(locale, args.seatId, args.seatId);
  if (locale === "es") {
    return args.onFloater
      ? `${args.displayName} (flotante): ${load} está Saturado — regresa a ayudar; tareas liberadas.`
      : `${args.displayName}: ${load} está Saturado — regresa a ${seat}; tareas liberadas.`;
  }
  return args.onFloater
    ? `${args.displayName} (floater): ${load} is Slammed — return to help; tareas unassigned.`
    : `${args.displayName}: ${load} is Slammed — return to ${seat}; tareas unassigned.`;
}
