import type { PublicDayV2, PublicHour } from "@/lib/quarter/client/day";
import type { CoverDisplay } from "@/lib/board/cover-display";
import type { OverlayDto } from "@/lib/overlays/read";

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
  /** Canonical explicit partitions. When present, legacy rows are not authoritative. */
  paintHours?: PublicHour[];
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
  quarter?: PublicDayV2;
  quarterManagerId?: string;
  /** Prepared bridge snapshot; ordinary hourly UI remains available until activation. */
  bridge?: PublicDayV2;
  board: "caja" | "cocina";
  date: string;
  stations: StationDto[];
  shifts: ShiftDto[];
  /** Shared read-only backup schedule; never included in primary paint or coverage. */
  auxiliaryShifts?: AuxiliaryShiftDto[];
  /** Validated persisted BREAK movements; absent on old offline snapshots. */
  coverDisplay?: CoverDisplay;
  /**
   * Per-station saved counts for the 28 days before `date`.
   * Absent only on a snapshot written before this field existed.
   */
  stationUse?: StationUseDto[];
  /** Cocina manager and owner only. Absent for staff and for caja. */
  mandatory?: MandatoryDto;
  /** Saved breaks on live shifts. No names and no passcode data. */
  breaks?: BreakStripeDto[];
  /** Every overlay for this board and date, including cancelled and ended rows. */
  overlays?: OverlayDto[];
  /** True only for a manager session on the server's Central today. */
  overlayMenu?: boolean;
};

export type BoardKindUi = "caja" | "cocina";

export type AuxiliaryShiftDto = Pick<ShiftDto, "id" | "date" | "startAt" | "endAt" | "sourcePosition"> & {
  employee: Pick<EmployeeDto, "id" | "firstName" | "lastName">;
};
