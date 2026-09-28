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
  abilities?: AbilityDto[];
};

export type AssignmentDto = {
  id: string;
  stationId: string;
  hourStart: string;
  hourEnd: string;
  /** True only when this person is forbidden at this station. No other level. */
  abilityBlocked?: boolean;
  /** Paint order in a numbered family. Null on a one-seat station. */
  seatNumber?: number | null;
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

export type MandatoryDto = {
  stationIds: string[];
  extraStationIds: string[];
  canMark: boolean;
};

export type DayBoardDto = {
  board: "caja" | "cocina";
  date: string;
  stations: StationDto[];
  shifts: ShiftDto[];
  /** Cocina manager and owner only. Absent for staff and for caja. */
  mandatory?: MandatoryDto;
};

export type BoardKindUi = "caja" | "cocina";
