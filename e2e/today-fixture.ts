import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";

/** Ordinary-manager UI regressions now use today; future fixtures remain owner-only. */
export async function seedTodayPeople(prefix: string) {
  const root = process.env.FLOOR_BOARDS_TEST_ROOT;
  if (!root) throw new Error("Disposable test root required");
  const date = formatInTimeZone(new Date(), "America/Chicago", "yyyy-MM-dd");
  const db = new PrismaClient({ datasources: { db: { url: `file:${path.join(root, "e2e.db")}` } } });
  try {
    for (let i = 0; i < 2; i++) {
      const person = await db.employee.upsert({ where: { externalId: `${prefix}-${i}` }, update: {}, create: { externalId: `${prefix}-${i}`, firstName: `Synthetic${i}`, lastName: prefix } });
      if (!await db.shift.findFirst({ where: { employeeId: person.id, date } })) {
        await db.shift.create({ data: { employeeId: person.id, date, board: "cocina", sourcePosition: "Cocina", startAt: fromZonedTime(`${date}T08:00:00`, "America/Chicago"), endAt: fromZonedTime(`${date}T16:00:00`, "America/Chicago") } });
      }
    }
  } finally { await db.$disconnect(); }
  return date;
}
