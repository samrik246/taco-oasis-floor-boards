import { afterAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { commitImport } from "@/lib/import/persist-import";
import { chicagoHourOf } from "@/lib/hour-grid";
import { parseScheduleWorkbook } from "@/lib/parser/schedule-parser";
import { ALL_STATIONS } from "@/lib/stations";
import { syntheticCsv, type SyntheticRow } from "./helpers/synthetic-schedule";

const prisma = new PrismaClient();
const stamp = `b4pr1-fijo-${Date.now()}`;
const date = "2031-04-07";
const position = `Caja Fijo ${stamp}`;

describe("fixed seats on import", () => {
  afterAll(async () => {
    const employees = await prisma.employee.findMany({
      where: { externalId: { startsWith: stamp } },
      select: { id: true },
    });
    const ids = employees.map((row) => row.id);
    if (ids.length) {
      await prisma.assignment.deleteMany({ where: { employeeId: { in: ids } } });
      await prisma.shift.deleteMany({ where: { employeeId: { in: ids } } });
      await prisma.employee.deleteMany({ where: { id: { in: ids } } });
    }
    await prisma.positionStationMap.deleteMany({ where: { position } });
    await prisma.importBatch.deleteMany({ where: { filename: `${stamp}.csv` } });
    await prisma.$disconnect();
  });

  it("fills an empty hour and skips an hour that is already painted", async () => {
    for (const station of ALL_STATIONS) {
      await prisma.station.upsert({
        where: { id: station.id },
        update: {},
        create: {
          id: station.id,
          board: station.board,
          label: station.label,
          color: station.color,
          maxConcurrent: station.maxConcurrent,
          sortOrder: station.sortOrder,
          priority: station.priority,
        },
      });
    }
    await prisma.positionStationMap.upsert({
      where: { position },
      update: { stationId: "green1" },
      create: { position, stationId: "green1" },
    });
    const rows: SyntheticRow[] = [
      {
        position,
        firstName: "Alma",
        lastName: "Fijo",
        employeeId: `${stamp}-a`,
        date,
        start: "8:00 am",
        end: "12:00 pm",
      },
      {
        position,
        firstName: "Beto",
        lastName: "Fijo",
        employeeId: `${stamp}-b`,
        date,
        start: "9:00 am",
        end: "1:00 pm",
      },
    ];
    const parsed = await parseScheduleWorkbook(syntheticCsv(rows), { filename: `${stamp}.csv` });
    await commitImport(parsed, `${stamp}.csv`);

    const people = await prisma.employee.findMany({
      where: { externalId: { startsWith: stamp } },
    });
    const alma = people.find((row) => row.externalId === `${stamp}-a`);
    const beto = people.find((row) => row.externalId === `${stamp}-b`);
    const seated = await prisma.assignment.findMany({
      where: { stationId: "green1", employeeId: { in: people.map((row) => row.id) } },
    });
    const hoursOf = (employeeId: string | undefined) =>
      seated
        .filter((row) => row.employeeId === employeeId)
        .map((row) => chicagoHourOf(row.hourStart))
        .sort((a, b) => a - b);
    expect(hoursOf(alma?.id)).toEqual([8, 9, 10, 11]);
    expect(hoursOf(beto?.id)).toEqual([12]);
  });
});
