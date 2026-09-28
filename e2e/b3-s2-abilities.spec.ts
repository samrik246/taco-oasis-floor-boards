import path from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { fromZonedTime } from "date-fns-tz";

const externalId = "b3s2-nia-sol";

test.beforeAll(async () => {
  const root = process.env.FLOOR_BOARDS_TEST_ROOT;
  if (!root) throw new Error("FLOOR_BOARDS_TEST_ROOT is missing");
  const prisma = new PrismaClient({
    datasources: { db: { url: `file:${path.join(root, "e2e.db")}` } },
  });
  const owner = await prisma.manager.updateMany({
    where: { name: "Sam Chen" },
    data: { role: "owner" },
  });
  if (owner.count !== 1) throw new Error(`expected one Sam Chen owner, updated ${owner.count}`);
  const existing = await prisma.employee.findUnique({ where: { externalId } });
  if (existing) {
    await prisma.employeeStationAbility.deleteMany({ where: { employeeId: existing.id } });
    await prisma.shift.deleteMany({ where: { employeeId: existing.id } });
    await prisma.employee.delete({ where: { id: existing.id } });
  }
  const person = await prisma.employee.create({
    data: {
      externalId,
      firstName: "Nia",
      lastName: "Sol",
      abilities: {
        create: [
          { stationId: "pdf_pr1e", level: "forbidden" },
          { stationId: "pdf_pr2e", level: "ok" },
          { stationId: "pdf_guia", level: "forbidden" },
        ],
      },
    },
  });
  await prisma.shift.create({
    data: {
      employeeId: person.id,
      date: "2034-06-11",
      startAt: new Date("2034-06-11T14:00:00.000Z"),
      endAt: new Date("2034-06-11T22:00:00.000Z"),
      sourcePosition: "Cocina",
      board: "cocina",
    },
  });
  await prisma.$disconnect();
});

async function keepDesk(page: Page) {
  await page.route("**/api/managers", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    const json = await response.json();
    json.idleMs = 120_000;
    await route.fulfill({ response, json });
  });
}

test("owner taps Habilidades through the four words and a mixed family becomes bien", async ({ page }) => {
  await page.goto("/back-office");
  await page.getByTestId("back-office-code").fill("8642");
  await page.getByTestId("back-office-submit").click();
  await page.getByTestId("back-office-tab-habilidades").click();
  const guia = page.getByTestId(`ability-cell-${externalId}-pdf_guia`);
  const family = page.getByTestId(`ability-cell-${externalId}-preparacion`);
  await expect(guia).toHaveText("no");
  await expect(family).toHaveText("mixto");
  await guia.click();
  await expect(guia).toHaveText("entrenando");
  await guia.click();
  await expect(guia).toHaveText("bien");
  await guia.click();
  await expect(guia).toHaveText("fuerte");
  await family.click();
  await expect(family).toHaveText("bien");

  await page.reload();
  await page.getByTestId("back-office-tab-habilidades").click();
  await expect(page.getByTestId(`ability-cell-${externalId}-pdf_guia`)).toHaveText("fuerte");
  await expect(page.getByTestId(`ability-cell-${externalId}-preparacion`)).toHaveText("bien");
});

test("manager and staff responses and screens carry no ability levels", async ({ page }) => {
  const payloads: string[] = [];
  page.on("response", async (response) => {
    const url = response.url();
    if (!response.ok()) return;
    if (!url.includes("/api/boards/") && !url.includes("/api/employees")) return;
    try {
      payloads.push(await response.text());
    } catch {
      /* a later reader took the body */
    }
  });
  await keepDesk(page);

  await page.goto("/back-office");
  await page.getByTestId("back-office-code").fill("2468");
  await page.getByTestId("back-office-submit").click();
  await expect(page.getByTestId("back-office-app")).toBeVisible();
  await expect(page.getByTestId("back-office-tab-habilidades")).toHaveCount(0);

  await page.goto("/");
  await expect(page.getByTestId("floor-board")).toHaveAttribute("data-role", "staff");
  await page.getByTestId("compact-manager").click();
  await page.getByTestId("manager-code-input").fill("2468");
  await page.getByTestId("manager-unlock-submit").click();
  await expect(page.getByTestId("floor-board")).toHaveAttribute("data-role", "manager");
  await page.getByTestId("compact-view").selectOption("board");
  await expect(page.getByTestId("floor-board")).toHaveAttribute("data-main-view", "board");
  await expect(page.getByTestId("ability-filter")).toHaveCount(0);
  await expect(page.getByTestId("ability-badge")).toHaveCount(0);
  await expect(page.locator("[data-testid^='favorite-']")).toHaveCount(0);
  await expect.poll(() => payloads.length).toBeGreaterThan(0);
  for (const body of payloads) expect(body).not.toContain('"abilities"');
});

function chicagoToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

test("a forbidden placement already on the board warns staff and a manager", async ({ page }) => {
  const today = chicagoToday();
  const root = process.env.FLOOR_BOARDS_TEST_ROOT;
  if (!root) throw new Error("FLOOR_BOARDS_TEST_ROOT is missing");
  const prisma = new PrismaClient({
    datasources: { db: { url: `file:${path.join(root, "e2e.db")}` } },
  });
  try {
    const person = await prisma.employee.findUniqueOrThrow({ where: { externalId } });
    await prisma.employeeStationAbility.upsert({
      where: { employeeId_stationId: { employeeId: person.id, stationId: "pdf_guia" } },
      create: { employeeId: person.id, stationId: "pdf_guia", level: "forbidden" },
      update: { level: "forbidden" },
    });
    const startAt = fromZonedTime(`${today}T09:00:00`, "America/Chicago");
    const endAt = fromZonedTime(`${today}T17:00:00`, "America/Chicago");
    let shift = await prisma.shift.findFirst({
      where: { employeeId: person.id, date: today, board: "cocina", boardRemoved: false },
    });
    if (!shift) {
      shift = await prisma.shift.create({
        data: {
          employeeId: person.id,
          date: today,
          startAt,
          endAt,
          sourcePosition: "Cocina",
          board: "cocina",
        },
      });
    }
    const already = await prisma.assignment.findFirst({
      where: { shiftId: shift.id, stationId: "pdf_guia" },
    });
    if (!already) {
      let placed = false;
      for (const hour of [10, 12, 13, 14, 15]) {
        const hourStart = fromZonedTime(
          `${today}T${String(hour).padStart(2, "0")}:00:00`,
          "America/Chicago",
        );
        const hourEnd = fromZonedTime(
          `${today}T${String(hour + 1).padStart(2, "0")}:00:00`,
          "America/Chicago",
        );
        const clash = await prisma.assignment.findFirst({
          where: {
            OR: [
              { employeeId: person.id, hourStart },
              { stationId: "pdf_guia", hourStart },
            ],
          },
        });
        if (clash) continue;
        await prisma.assignment.create({
          data: {
            shiftId: shift.id,
            employeeId: person.id,
            stationId: "pdf_guia",
            hourStart,
            hourEnd,
          },
        });
        placed = true;
        break;
      }
      if (!placed) throw new Error("no free hour for the forbidden placement");
    }
  } finally {
    await prisma.$disconnect();
  }

  const dayBodies: string[] = [];
  page.on("response", async (response) => {
    if (!response.ok() || !response.url().includes(`/api/boards/cocina/days/${today}`)) return;
    try {
      dayBodies.push(await response.text());
    } catch {
      /* a later reader took the body */
    }
  });

  await page.goto(`/?board=cocina`);
  await expect(page.getByTestId("floor-board")).toHaveAttribute("data-role", "staff");
  const banner = page.getByTestId("violations-banner");
  await expect(banner).toContainText("Nia Sol");
  await expect(banner).toContainText("Esta persona no puede trabajar esa estación.");

  await keepDesk(page);
  await page.getByTestId("compact-manager").click();
  await page.getByTestId("manager-code-input").fill("2468");
  await page.getByTestId("manager-unlock-submit").click();
  await expect(page.getByTestId("floor-board")).toHaveAttribute("data-role", "manager");
  await expect(page.getByTestId("violations-banner")).toContainText("Nia Sol");
  await expect(page.getByTestId("violations-banner")).toContainText("Esta persona no puede trabajar esa estación.");
  expect(dayBodies.length).toBeGreaterThan(0);
  for (const body of dayBodies) {
    expect(body).not.toContain('"abilities"');
    expect(body).toContain('"abilityBlocked":true');
  }
});
