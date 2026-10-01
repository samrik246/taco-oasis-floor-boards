import { quarterState } from "@/lib/quarter/schema";
import { resolvePaintWorld, assignedIntervals } from "@/lib/quarter/world";
import { TIMEZONE } from "@/lib/constants";
import { toZonedTime, fromZonedTime } from "date-fns-tz";
import { shiftOverlapMinutes } from "@/lib/rules/shift-window";
import type {
  EmployeeHoursLedger,
  LedgerStationRow,
  LedgerTareaRow,
} from "@/lib/ledger-types";

export type { EmployeeHoursLedger, LedgerStationRow, LedgerTareaRow };

/** Format local Chicago calendar components as YYYY-MM-DD. */
function ymdFromLocalParts(y: number, monthIndex: number, day: number): string {
  const m = String(monthIndex + 1).padStart(2, "0");
  const d = String(day).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Week containing `dateYmd`: Sunday–Saturday in America/Chicago
 * (US restaurant convention). Documented in docs/DECISIONS.md.
 */
export function chicagoWeekBounds(dateYmd: string): {
  weekStart: string;
  weekEnd: string;
  rangeStart: Date;
  rangeEnd: Date;
} {
  const noon = fromZonedTime(`${dateYmd}T12:00:00`, TIMEZONE);
  const local = toZonedTime(noon, TIMEZONE);
  const dow = local.getDay(); // 0 = Sunday
  const sunday = new Date(local.getFullYear(), local.getMonth(), local.getDate() - dow);
  const saturday = new Date(sunday.getFullYear(), sunday.getMonth(), sunday.getDate() + 6);

  const weekStart = ymdFromLocalParts(
    sunday.getFullYear(),
    sunday.getMonth(),
    sunday.getDate(),
  );
  const weekEnd = ymdFromLocalParts(
    saturday.getFullYear(),
    saturday.getMonth(),
    saturday.getDate(),
  );

  return {
    weekStart,
    weekEnd,
    rangeStart: fromZonedTime(`${weekStart}T00:00:00`, TIMEZONE),
    rangeEnd: fromZonedTime(`${weekEnd}T23:59:59.999`, TIMEZONE),
  };
}

/** Minutes between two Date instants (tarea duration). */
export function assignmentMinutes(hourStart: Date, hourEnd: Date): number {
  const ms = hourEnd.getTime() - hourStart.getTime();
  return Math.max(0, Math.round(ms / 60_000));
}

/**
 * Ledger minutes for one station assignment: the overlap of its clock hour
 * with its shift (C1). A 16:00–16:30 shift assigned at hour 16 counts 30.
 */
export function assignmentLedgerMinutes(
  a: { hourStart: Date; hourEnd: Date },
  shift: { startAt: Date; endAt: Date },
): number {
  return shiftOverlapMinutes(a.hourStart, a.hourEnd, shift.startAt, shift.endAt);
}

/**
 * Aggregate assignment minutes for an employee in the Chicago week
 * containing `weekOfDate` (YYYY-MM-DD). Includes station + tarea minutes.
 */
export async function getEmployeeWeekHours(
  employeeId: string,
  weekOfDate: string,
): Promise<EmployeeHoursLedger | null> {
  const { prisma } = await import("@/lib/db");

  const employee = await prisma.employee.findUnique({
    where: { id: employeeId },
    select: { id:true, firstName:true, lastName:true },
  });
  if (!employee) return null;

  const { weekStart, weekEnd, rangeStart, rangeEnd } =
    chicagoWeekBounds(weekOfDate);

  const byStationMap = new Map<string,{stationId:string;stationLabel:string;minutes:number}>();
  await prisma.$transaction(async tx => {
    if ((await quarterState(tx))?.phase === "active") {
      const dates=await tx.shift.findMany({where:{employeeId,date:{gte:weekStart,lte:weekEnd}},select:{date:true},distinct:["date"]});
      const totals=new Map<string,{label:string;ms:number}>();
      for(const {date} of dates) {
        const world=await resolvePaintWorld(tx,date);
        for(const interval of assignedIntervals(world,false).filter(s=>s.employeeId===employeeId)) {
          const id=interval.stationId!;const total=totals.get(id)??{label:world.stations.find(s=>s.id===id)!.label,ms:0};
          total.ms+=interval.endMs-interval.startMs;totals.set(id,total);
        }
      }
      for(const [stationId,total] of totals)byStationMap.set(stationId,{stationId,stationLabel:total.label,minutes:Math.round(total.ms/60_000)});
    } else {
      const assignments=await tx.assignment.findMany({where:{shift:{employeeId},hourStart:{gte:rangeStart,lte:rangeEnd}},include:{station:true,shift:{select:{startAt:true,endAt:true}}}});
      for(const a of assignments) {
        const prior=byStationMap.get(a.stationId)??{stationId:a.stationId,stationLabel:a.station.label,minutes:0};
        prior.minutes+=assignmentLedgerMinutes(a,a.shift);byStationMap.set(a.stationId,prior);
      }
    }
  });

  const byStation: LedgerStationRow[] = [...byStationMap.values()]
    .map((r) => ({
      ...r,
      hours: Math.round((r.minutes / 60) * 100) / 100,
    }))
    .sort(
      (a, b) =>
        b.minutes - a.minutes || a.stationLabel.localeCompare(b.stationLabel),
    );

  const totalMinutes = byStation.reduce((s, r) => s + r.minutes, 0);

  // Tarea minutes: Chicago date strings in week (YYYY-MM-DD lexicographic)
  const tareas = await prisma.tareaAssignment.findMany({
    where: {
      employeeId,
      date: { gte: weekStart, lte: weekEnd },
    },
    include: { template: true },
  });

  const byTareaMap = new Map<
    string,
    { templateId: string; templateLabel: string; minutes: number }
  >();

  for (const t of tareas) {
    const end = t.completedAt ?? t.unassignedAt;
    if (!end) continue; // still working — don't count open duration in ledger yet
    const mins = assignmentMinutes(t.assignedAt, end);
    if (mins <= 0) continue;
    const prev = byTareaMap.get(t.templateId);
    if (prev) {
      prev.minutes += mins;
    } else {
      byTareaMap.set(t.templateId, {
        templateId: t.templateId,
        templateLabel: t.template.label,
        minutes: mins,
      });
    }
  }

  const byTarea: LedgerTareaRow[] = [...byTareaMap.values()]
    .map((r) => ({
      ...r,
      hours: Math.round((r.minutes / 60) * 100) / 100,
    }))
    .sort(
      (a, b) =>
        b.minutes - a.minutes ||
        a.templateLabel.localeCompare(b.templateLabel),
    );

  const totalTareaMinutes = byTarea.reduce((s, r) => s + r.minutes, 0);

  return {
    employeeId: employee.id,
    firstName: employee.firstName,
    lastName: employee.lastName,
    weekStart,
    weekEnd,
    totalMinutes,
    totalHours: Math.round((totalMinutes / 60) * 100) / 100,
    byStation,
    byTarea,
    totalTareaMinutes,
    totalTareaHours: Math.round((totalTareaMinutes / 60) * 100) / 100,
  };
}
