import { prisma } from "@/lib/db";
import { ALL_STATIONS } from "@/lib/stations";
import { hourGridHours, chicagoHourStart, chicagoHourEnd } from "@/lib/hour-grid";
import { isHourInShift } from "@/lib/rules/shift-window";

const DEMO_DATES = ["2026-09-20", "2026-09-21"] as const;

/**
 * Caja: only seed a few color seats so Schedule is visible but cashiers e2e
 * still has people available for Yellow (and other primaries).
 * Cocina: seed all stations.
 */
const CAJA_SEED_STATIONS = new Set(["mana", "green1", "purple1", "nieves"]);

/**
 * After sample import, seat people on stations across demo dates so the
 * Schedule view is visibly filled (cocina colores / caja colors style).
 * Idempotent: skips hours that already have an assignment for that person
 * or a full station. Uses bulk create for speed.
 */
export async function seedDemoScheduleAssignments(): Promise<{
  created: number;
  dates: string[];
}> {
  const dates = [...DEMO_DATES];
  const toCreate: Array<{
    shiftId: string;
    stationId: string;
    hourStart: Date;
    hourEnd: Date;
  }> = [];

  for (const date of dates) {
    for (const board of ["caja", "cocina"] as const) {
      const stations = ALL_STATIONS.filter((s) => {
        if (s.board !== board) return false;
        if (board === "caja" && !CAJA_SEED_STATIONS.has(s.id)) return false;
        return true;
      }).sort((a, b) => a.sortOrder - b.sortOrder);
      const shifts = await prisma.shift.findMany({
        where: { date, board },
        include: { assignments: true },
        orderBy: { startAt: "asc" },
      });
      if (shifts.length === 0 || stations.length === 0) continue;

      const abilities = await prisma.employeeStationAbility.findMany({
        where: {
          employeeId: { in: shifts.map((s) => s.employeeId) },
          stationId: { in: stations.map((s) => s.id) },
        },
      });
      const forbidden = new Set(
        abilities
          .filter((a) => a.level === "forbidden")
          .map((a) => `${a.employeeId}:${a.stationId}`),
      );

      // Track occupancy / person-hour in memory (plus existing DB rows)
      const stationHourOcc = new Map<string, number>();
      const personHour = new Set<string>();
      for (const sh of shifts) {
        for (const a of sh.assignments) {
          const key = `${a.stationId}:${a.hourStart.getTime()}`;
          stationHourOcc.set(key, (stationHourOcc.get(key) ?? 0) + 1);
          personHour.add(`${sh.employeeId}:${a.hourStart.getTime()}`);
        }
      }

      for (const hour of hourGridHours()) {
        const hourStart = chicagoHourStart(date, hour);
        const hourEnd = chicagoHourEnd(date, hour);
        const t = hourStart.getTime();
        const available = shifts.filter((sh) => {
          if (!isHourInShift(hourStart, sh.startAt, sh.endAt)) return false;
          return !personHour.has(`${sh.employeeId}:${t}`);
        });

        let personIdx = 0;
        for (const station of stations) {
          const occKey = `${station.id}:${t}`;
          const occ = stationHourOcc.get(occKey) ?? 0;
          if (station.maxConcurrent > 0 && occ >= station.maxConcurrent) {
            continue;
          }
          while (personIdx < available.length) {
            const sh = available[personIdx]!;
            personIdx += 1;
            if (forbidden.has(`${sh.employeeId}:${station.id}`)) continue;
            if (personHour.has(`${sh.employeeId}:${t}`)) continue;

            toCreate.push({
              shiftId: sh.id,
              stationId: station.id,
              hourStart,
              hourEnd,
            });
            stationHourOcc.set(occKey, occ + 1);
            personHour.add(`${sh.employeeId}:${t}`);
            break;
          }
        }
      }
    }
  }

  if (toCreate.length > 0) {
    await prisma.assignment.createMany({ data: toCreate });
  }

  return { created: toCreate.length, dates };
}

export function demoDates(): readonly string[] {
  return DEMO_DATES;
}
