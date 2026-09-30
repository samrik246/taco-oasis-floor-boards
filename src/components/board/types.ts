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
  /** Owner pages only. The floor day payload does not send this. */
  externalId?: string;
  firstName: string;
  lastName: string;
  email: string | null;
  abilities?: AbilityDto[];
};

export type BreakStripeDto = {
  employeeId: string;
  shiftId: string;
  startAt: string;
  endAt: string;
  coverEmployeeId?: string | null;
  auto?: boolean;
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

/** Saved assignment rows for one station. No person and no ability level. */
export type StationUseDto = {
  stationId: string;
  count: number;
};

export type DayBoardDto = {
  board: "caja" | "cocina";
  date: string;
  stations: StationDto[];
  shifts: ShiftDto[];
  /**
   * Per-station saved counts for the 28 days before `date`.
   * Absent only on a snapshot written before this field existed.
   */
  stationUse?: StationUseDto[];
  /** Cocina manager and owner only. Absent for staff and for caja. */
  mandatory?: MandatoryDto;
  /** Saved breaks on live shifts. No names and no passcode data. */
  breaks?: BreakStripeDto[];
};

export type BoardKindUi = "caja" | "cocina";
