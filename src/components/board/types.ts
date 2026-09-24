/** Shared board DTO types matching GET /api/boards/:board/days/:date */

export type AbilityLevel = "forbidden" | "training" | "ok" | "preferred";

export type StationDto = {
  id: string;
  label: string;
  color: string;
  maxConcurrent: number;
  sortOrder: number;
  priority: number | null;
  shortCode?: string;
};

export type AbilityDto = {
  stationId: string;
  level: AbilityLevel;
};

export type EmployeeDto = {
  id: string;
  externalId: string;
  firstName: string;
  lastName: string;
  email: string | null;
  abilities: AbilityDto[];
};

export type AssignmentDto = {
  id: string;
  stationId: string;
  hourStart: string;
  hourEnd: string;
};

export type ShiftDto = {
  id: string;
  date: string;
  startAt: string;
  endAt: string;
  sourcePosition: string;
  board: string;
  /** Set when a newer import replaced this shift; only its history hours show (C1). */
  supersededAt?: string | null;
  employee: EmployeeDto;
  assignments: AssignmentDto[];
};

export type DayBoardDto = {
  board: "caja" | "cocina";
  date: string;
  stations: StationDto[];
  shifts: ShiftDto[];
};

export type BoardKindUi = "caja" | "cocina";
