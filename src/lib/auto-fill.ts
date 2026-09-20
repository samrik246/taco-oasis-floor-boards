/**
 * Auto-fill algorithm stub only (SPEC §4.6). Do not invent fill logic in beta.
 */

export type DayContext = {
  board: "caja" | "cocina";
  date: string;
};

export type AssignmentSuggestion = {
  employeeExternalId: string;
  stationId: string;
  hourStart: string;
};

export interface AutoFillEngine {
  suggest(input: DayContext): AssignmentSuggestion[];
}

export class NoOpAutoFill implements AutoFillEngine {
  suggest(_input: DayContext): AssignmentSuggestion[] {
    return [];
  }
}

export const autoFillEngine: AutoFillEngine = new NoOpAutoFill();
