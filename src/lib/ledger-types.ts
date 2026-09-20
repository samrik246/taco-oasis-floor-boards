/** Shared hours-ledger DTO (safe for client imports). */

export type LedgerStationRow = {
  stationId: string;
  stationLabel: string;
  minutes: number;
  hours: number;
};

export type LedgerTareaRow = {
  templateId: string;
  templateLabel: string;
  minutes: number;
  hours: number;
};

export type EmployeeHoursLedger = {
  employeeId: string;
  firstName: string;
  lastName: string;
  /** YYYY-MM-DD week bounds in America/Chicago (Sunday–Saturday) */
  weekStart: string;
  weekEnd: string;
  totalMinutes: number;
  totalHours: number;
  byStation: LedgerStationRow[];
  /** Minutes spent on tareas (assignedAt → completedAt/unassignedAt/now) */
  totalTareaMinutes: number;
  totalTareaHours: number;
  byTarea: LedgerTareaRow[];
};
