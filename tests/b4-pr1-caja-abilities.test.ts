import { afterAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { GET as abilityGrid } from "@/app/api/admin/abilities/route";
import { cajaAbilityColumns } from "@/lib/abilities/levels";
import { hashManagerCode } from "@/lib/managers/codes";
import { signManagerSession } from "@/lib/managers/session";
import { CAJA_STATIONS } from "@/lib/stations";
import { chicagoDateTime } from "@/lib/time";

const prisma = new PrismaClient();
const stamp = `b4pr1-caja-${Date.now()}`;

function authed(token: string, url: string) {
  return new Request(url, { headers: { "x-manager-session": token } });
}

describe("Habilidades caja", () => {
  afterAll(async () => {
    const employees = await prisma.employee.findMany({
      where: { externalId: { startsWith: stamp } },
      select: { id: true },
    });
    const ids = employees.map((row) => row.id);
    if (ids.length) {
      await prisma.shift.deleteMany({ where: { employeeId: { in: ids } } });
      await prisma.employee.deleteMany({ where: { id: { in: ids } } });
    }
    await prisma.manager.deleteMany({ where: { name: { startsWith: stamp } } });
    await prisma.$disconnect();
  });

  it("accepts caja for an owner and still rejects a board that is neither", async () => {
    for (const station of CAJA_STATIONS) {
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
    const owner = await prisma.manager.create({
      data: { name: `${stamp} Owner`, codeHash: hashManagerCode(`${stamp}-owner`), role: "owner" },
    });
    const token = signManagerSession({ id: owner.id, name: owner.name });
    const person = await prisma.employee.create({
      data: { externalId: `${stamp}-ada`, firstName: "Ada", lastName: "Caja" },
    });
    await prisma.shift.create({
      data: {
        employeeId: person.id,
        date: "2035-03-03",
        startAt: chicagoDateTime("2035-03-03", "9:00 am"),
        endAt: chicagoDateTime("2035-03-03", "5:00 pm"),
        sourcePosition: "Caja",
        board: "caja",
      },
    });

    const bad = await abilityGrid(authed(token, "http://local/api/admin/abilities?board=other"));
    expect(bad.status).toBe(400);

    const got = await abilityGrid(authed(token, "http://local/api/admin/abilities?board=caja"));
    expect(got.status).toBe(200);
    const grid = await got.json();
    expect(grid.board).toBe("caja");
    expect(grid.columns.map((column: { key: string }) => column.key)).toEqual(
      cajaAbilityColumns().map((column) => column.key),
    );
    expect(grid.people.map((row: { externalId: string }) => row.externalId)).toContain(`${stamp}-ada`);
  });
});
