import { afterAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PATCH as patchStation } from "@/app/api/admin/stations/[id]/route";
import { GET as listManagers } from "@/app/api/admin/managers/route";
import { POST as seat } from "@/app/api/admin/seat-plan/route";
import { PUT as saveSales } from "@/app/api/admin/sales/route";
import { GET as rush } from "@/app/api/rush/route";
import { hashManagerCode } from "@/lib/managers/codes";
import { signManagerSession } from "@/lib/managers/session";
import { hourGridHours } from "@/lib/hour-grid";
import { historicalSaleRows } from "@/lib/rush/historical-sales";
import { chicagoDateTime } from "@/lib/time";

const prisma = new PrismaClient();

async function managerToken() {
  const codeHash = hashManagerCode("2468");
  const existing = await prisma.manager.findFirst({ where: { name: "Ana Rivera" } });
  const manager = existing
    ? await prisma.manager.update({
        where: { id: existing.id },
        data: { codeHash, active: true },
      })
    : await prisma.manager.create({
        data: { name: "Ana Rivera", codeHash, active: true },
      });
  return signManagerSession({ id: manager.id, name: manager.name });
}

function authed(token: string, url: string, init?: RequestInit) {
  const headers = new Headers(init?.headers);
  headers.set("x-manager-session", token);
  return new Request(url, { ...init, headers });
}

describe("back office persistence", () => {
  afterAll(async () => {
    await prisma.station.update({
      where: { id: "yellow" },
      data: { label: "Yellow / Outside", shortCode: "YEL", color: "yellow", board: "caja" },
    }).catch(() => undefined);
    await prisma.$disconnect();
  });

  async function ensureYellow() {
    await prisma.station.upsert({
      where: { id: "yellow" },
      create: {
        id: "yellow",
        board: "caja",
        label: "Yellow / Outside",
        color: "yellow",
        shortCode: "YEL",
        maxConcurrent: 1,
        sortOrder: 2,
      },
      update: { maxConcurrent: 1 },
    });
  }

  it("rejects a station write without a manager session", async () => {
    const res = await patchStation(
      new Request("http://local/api/admin/stations/yellow", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          label: "Nope",
          color: "yellow",
          shortCode: "YEL",
          board: "caja",
        }),
      }),
      { params: Promise.resolve({ id: "yellow" }) },
    );
    expect(res.status).toBe(401);
  });

  it("saves a station label and the floor board reads it", async () => {
    await ensureYellow();
    const token = await managerToken();
    const res = await patchStation(
      authed(token, "http://local/api/admin/stations/yellow", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          label: "Yellow Lane",
          color: "yellow",
          shortCode: "YEL",
          board: "caja",
        }),
      }),
      { params: Promise.resolve({ id: "yellow" }) },
    );
    expect(res.status).toBe(200);
    const row = await prisma.station.findUnique({ where: { id: "yellow" } });
    expect(row?.label).toBe("Yellow Lane");
    expect(row?.shortCode).toBe("YEL");
  });

  it("rejects sales percents that do not add up, then saves a valid day", async () => {
    const token = await managerToken();
    const hours = hourGridHours();
    const bad = await saveSales(
      authed(token, "http://local/api/admin/sales", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          board: "caja",
          dow: 1,
          percents: hours.map((hour) => ({ hour, percent: 1 })),
        }),
      }),
    );
    expect(bad.status).toBe(422);
    const badBody = (await bad.json()) as { error: string };
    expect(badBody.error).toMatch(/about 100%/);

    const secret = await saveSales(
      authed(token, "http://local/api/admin/sales", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          board: "caja",
          dow: 1,
          code: "2468",
          percents: hours.map((hour) => ({ hour, percent: hour === 12 ? 100 : 0 })),
        }),
      }),
    );
    expect(secret.status).toBe(422);
    const secretBody = (await secret.json()) as { error: string };
    expect(secretBody.error).toMatch(/never shown/);

    const saved = await saveSales(
      authed(token, "http://local/api/admin/sales", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          board: "caja",
          dow: 1,
          percents: hours.map((hour) => ({
            hour,
            percent: hour === 12 ? 40 : hour === 18 ? 60 : 0,
          })),
        }),
      }),
    );
    expect(saved.status).toBe(200);
    const rushRes = await rush(
      new Request("http://local/api/rush?board=caja&date=2026-09-21"),
    );
    expect(rushRes.status).toBe(200);
    const body = (await rushRes.json()) as {
      metric: string;
      forecast: { hours: { hour: number; mean: number; rush: boolean }[] };
    };
    expect(body.metric).toBe("percent-of-day-sales");
    const noon = body.forecast.hours.find((hour) => hour.hour === 12);
    expect(noon?.mean).toBeGreaterThan(30);
    expect(noon?.rush).toBe(true);

    await prisma.historicalHourlySale.deleteMany({ where: { board: "caja", dow: 1 } });
    await prisma.historicalHourlySale.createMany({
      data: historicalSaleRows().filter((row) => row.board === "caja" && row.dow === 1),
    });
  });

  it("refuses a second person on the same station", async () => {
    await ensureYellow();
    const token = await managerToken();
    const stamp = Date.now();
    const employee = await prisma.employee.create({
      data: {
        externalId: `seat-${stamp}`,
        firstName: "Seat",
        lastName: "Test",
      },
    });
    const other = await prisma.employee.create({
      data: {
        externalId: `seat-b-${stamp}`,
        firstName: "Other",
        lastName: "Test",
      },
    });
    const shiftA = await prisma.shift.create({
      data: {
        employeeId: employee.id,
        date: "2026-01-15",
        startAt: chicagoDateTime("2026-01-15", "8:00 am"),
        endAt: chicagoDateTime("2026-01-15", "4:00 pm"),
        sourcePosition: "Caja",
        board: "caja",
      },
    });
    const shiftB = await prisma.shift.create({
      data: {
        employeeId: other.id,
        date: "2026-01-15",
        startAt: chicagoDateTime("2026-01-15", "8:00 am"),
        endAt: chicagoDateTime("2026-01-15", "4:00 pm"),
        sourcePosition: "Caja",
        board: "caja",
      },
    });
    const first = await seat(
      authed(token, "http://local/api/admin/seat-plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shiftId: shiftA.id,
          stationId: "yellow",
          date: "2026-01-15",
          hour: 10,
        }),
      }),
    );
    expect(first.status).toBe(201);
    const second = await seat(
      authed(token, "http://local/api/admin/seat-plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shiftId: shiftB.id,
          stationId: "yellow",
          date: "2026-01-15",
          hour: 10,
        }),
      }),
    );
    expect(second.status).toBe(422);
    const body = (await second.json()) as { error: string };
    expect(body.error).toMatch(/One person per station/);

    await prisma.assignment.deleteMany({ where: { shiftId: { in: [shiftA.id, shiftB.id] } } });
    await prisma.shift.deleteMany({ where: { id: { in: [shiftA.id, shiftB.id] } } });
    await prisma.employee.deleteMany({ where: { id: { in: [employee.id, other.id] } } });
  });

  it("lists managers without codes", async () => {
    const token = await managerToken();
    const res = await listManagers(authed(token, "http://local/api/admin/managers"));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toMatch(/codeHash/);
    expect(text).not.toMatch(/2468/);
    expect(text).not.toMatch(/1357/);
    expect(text).not.toMatch(/8642/);
    const data = JSON.parse(text) as { managers: { name: string }[] };
    expect(data.managers.some((row) => row.name === "Ana Rivera")).toBe(true);
  });
});
