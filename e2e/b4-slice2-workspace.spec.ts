import path from "node:path";
import { mkdirSync } from "node:fs";
import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { formatInTimeZone } from "date-fns-tz";
import { hashManagerCode } from "../src/lib/managers/codes";
import { chicagoDateTime } from "../src/lib/time";

const root = process.env.FLOOR_BOARDS_TEST_ROOT;
if (!root) throw new Error("Disposable database required");
const prisma = new PrismaClient({ datasources: { db: { url: `file:${path.join(root, "e2e.db")}` } } });
const screens = path.resolve("../../WORK_LOGS/COLOR_BOARDS_B4_SLICE2_YUKI_EVIDENCE_2026_09_30/screens");
const date = formatInTimeZone(new Date(), "America/Chicago", "yyyy-MM-dd");
const iso = (time: string) => chicagoDateTime(date, time).toISOString();
async function screenshot(page: Page, name: string) { mkdirSync(screens, { recursive: true }); await page.screenshot({ path: path.join(screens, `${name}.png`), fullPage: true }); }

async function workerUI(page: Page, state: string | null = null) {
  const saved = state ? { board: "cocina", startAt: iso("2:00 pm"), endAt: iso("2:30 pm"), state, approval: state === "ended" ? null : "gerente", status: state === "pending" ? "pending" : state === "ended" ? "ended" : "booked" } : null;
  const data = { name: "Mara Ejemplo", allowanceMinutes: 60, shifts: [{ board: "cocina", startAt: iso("8:00 am"), endAt: iso("4:00 pm") }], blocked: [], slots: [
    { board: "cocina", startAt: iso("2:00 pm"), endAt: iso("2:30 pm"), approval: "gerente" },
    { board: "cocina", startAt: iso("2:00 pm"), endAt: iso("3:00 pm"), approval: "automatic" },
  ], saved };
  await page.route("**/api/breaks/session", route => route.fulfill({ json: { kind: "staff", token: "synthetic-ui-token", name: data.name } }));
  await page.route("**/api/breaks/mine", async route => {
    if (route.request().method() === "POST") { data.saved = { board: "cocina", startAt: iso("2:00 pm"), endAt: iso("2:30 pm"), state: "pending", approval: "gerente", status: "pending" }; await route.fulfill({ json: { waiting: true, startAt: data.saved.startAt, endAt: data.saved.endAt } }); }
    else await route.fulfill({ json: data });
  });
  await page.route("**/api/breaks/timeline**", route => route.fulfill({ json: {
    date, asOf: iso("9:30 am"), gerenteAvailable: false, people: [], breaks: [
      { id: "later", employeeId: "b", firstName: "Sol", board: "caja", startAt: iso("3:00 pm"), endAt: iso("3:30 pm"), state: "pending", approval: "gerente" },
      { id: "earlier", employeeId: "a", firstName: "Mara", board: "cocina", startAt: iso("2:00 pm"), endAt: iso("2:30 pm"), state: "pending", approval: "gerente" },
      ...Array.from({ length: 6 }, (_, i) => ({ id: `reserve-${i}`, employeeId: `p-${i}`, firstName: `Ejemplo ${i + 1}`, board: i % 2 ? "caja" : "cocina", startAt: iso("4:00 pm"), endAt: iso("4:30 pm"), state: i === 0 ? "on-break" : "reserved", approval: "automatic" })),
    ],
  } }));
  return data;
}
async function enterWorker(page: Page) { for (const digit of "4545") await page.getByTestId(`break-key-${digit}`).click(); await expect(page.getByTestId("break-worker")).toBeVisible(); }

test("landscape sheet, both-area ordered overflow, per-length approval and persisted pending state", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await workerUI(page);
  await page.goto("/?board=caja&kiosk=1");
  await expect(page.getByTestId("break-strip")).toBeVisible();
  await expect(page.getByTestId("break-strip").getByTestId("break-chip").first()).toContainText("Mara · Cocina");
  await page.getByTestId("open-descansos").click();
  await expect(page.getByTestId("break-keypad")).toBeVisible();
  await expect(page.getByText("Personal", { exact: true })).toHaveCount(0);
  const sheet = await page.getByTestId("break-sheet").boundingBox();
  expect(sheet!.width).toBeGreaterThan(1200);
  await screenshot(page, "01_CODE_ENTRY");
  await enterWorker(page);
  await expect(page.getByTestId("break-shift")).toContainText("Te tocan máximo 60 minutos");
  await page.locator(`[data-testid="break-start"][data-start="${iso("2:00 pm")}"]`).click();
  await expect(page.getByTestId("break-home")).toContainText("Disponible · Aprobación automática");
  await page.locator(`[data-testid="break-slot"][data-end="${iso("2:30 pm")}"]`).click();
  await expect(page.getByTestId("break-home")).toContainText("Disponible · Requiere aprobación del gerente");
  await screenshot(page, "02_WORKER_PICKER");
  await page.getByTestId("break-save").click();
  await expect(page.getByTestId("break-saved-title")).toHaveText("Pendiente");
  await expect(page.getByTestId("break-saved")).toContainText("Visible para el gerente.");
  await expect(page.getByTestId("break-saved")).toContainText("Espera la aprobación antes de salir a tu BREAK.");
  await expect(page.getByTestId("break-saved")).not.toContainText(/puesto obligatorio|sin aprobación|Libre/);
  await screenshot(page, "03_PENDING");
  await page.getByTestId("break-back").click();
  await expect(page.getByTestId("break-worker")).toBeVisible();
  await page.getByTestId("break-close").click();
  await expect(page.getByTestId("break-sheet")).toHaveCount(0);
  await page.getByTestId("open-descansos").click();
  await enterWorker(page);
  await expect(page.getByTestId("break-status")).toContainText("Pendiente");
});

test("ended requests stay distinct from completed and stale login cannot reopen a closed session", async ({ page }) => {
  await workerUI(page, "ended");
  await page.goto("/descansos?board=caja");
  await enterWorker(page);
  await expect(page.getByTestId("break-status")).toContainText("Solicitud finalizada sin BREAK");
  await expect(page.getByTestId("break-status")).not.toContainText("Completado");
  await page.getByTestId("break-close").click();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/breaks/session", async route => { await held; await route.fulfill({ json: { kind: "staff", token: "late", name: "Late" } }); });
  for (const digit of "4545") await page.getByTestId(`break-key-${digit}`).click();
  await page.getByTestId("break-close").click();
  release();
  await expect(page.getByTestId("break-keypad")).toBeVisible();
  await expect(page.getByTestId("break-worker")).toHaveCount(0);
});

test("real long manager credential, both-board queue, own break, owner pairing and revoked access", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const person = await prisma.employee.create({ data: { externalId: `b4s2-${Date.now()}`, firstName: "Sofia", lastName: "Ejemplo" } });
  const shift = await prisma.shift.create({ data: { employeeId: person.id, date, board: "caja", sourcePosition: "Caja Manager", startAt: chicagoDateTime(date, "8:00 am"), endAt: chicagoDateTime(date, "8:00 pm") } });
  const owner = await prisma.manager.create({ data: { name: "Owner Ejemplo", codeHash: hashManagerCode("synthetic-owner-long-credential"), active: true, role: "owner", employeeId: person.id } });
  const unlinked = await prisma.manager.create({ data: { name: "Gerente Ejemplo", codeHash: hashManagerCode("synthetic-unlinked-long-credential"), active: true, role: "manager", longIdle: true } });
  await prisma.staffBreak.create({ data: { employeeId: person.id, shiftId: shift.id, date, board: "caja", actor: person.id, status: "pending", startAt: chicagoDateTime(date, "2:00 pm"), endAt: chicagoDateTime(date, "2:30 pm") } });
  await prisma.staffPasscodeAttempt.deleteMany({ where: { board: "cocina" } });
  await page.goto("/descansos?board=cocina");
  await page.getByTestId("break-credential-mode").click();
  await page.getByTestId("break-code-input").fill("synthetic-owner-long-credential");
  await page.getByTestId("break-sign-in").click();
  await expect(page.getByTestId("break-gerente")).toBeVisible();
  await expect(page.getByTestId("break-gerente")).toContainText("Sofia");
  await screenshot(page, "04_GERENTE_QUEUE");
  await page.getByTestId("break-review").last().click();
  await expect(page.getByTestId("descanso-dialog")).toBeVisible();
  await expect(page.getByTestId("descanso-clear")).toHaveText("Rechazar solicitud");
  await screenshot(page, "05_COVER_REVIEW");
  await page.getByTestId("descanso-close").click();
  await page.getByTestId("break-own").click();
  await expect(page.getByTestId("break-name")).toHaveText("Sofia Ejemplo");
  await page.getByTestId("break-back").click();
  await expect(page.getByTestId("break-gerente")).toBeVisible();
  await page.getByTestId("break-pairing-open").click();
  await expect(page.getByTestId("manager-pairing")).toContainText("Gerente Ejemplo · Sin vínculo");
  await page.getByLabel("Persona para Gerente Ejemplo", { exact: true }).selectOption(person.id);
  expect((await prisma.manager.findUniqueOrThrow({ where: { id: unlinked.id } })).employeeId).toBeNull();
  await screenshot(page, "06_OWNER_PAIRING");
  await page.getByTestId("pairing-confirm").click();
  await expect(page.getByTestId("manager-pairing")).toContainText("Gerente Ejemplo · Vinculado");
  expect((await prisma.manager.findUniqueOrThrow({ where: { id: unlinked.id } })).employeeId).toBe(person.id);
  await page.getByTestId("break-back").click();
  await page.getByTestId("break-date").fill("2040-06-06");
  await expect(page.getByTestId("break-gerente")).toContainText("Solo consulta");
  await expect(page.getByTestId("break-review")).toHaveCount(0);
  await prisma.manager.update({ where: { id: owner.id }, data: { active: false } });
  await page.getByRole("button", { name: "Actualizar", exact: true }).click();
  await expect(page.getByTestId("break-keypad")).toBeVisible();
  await expect(page.getByTestId("manager-pairing")).toHaveCount(0);
  await expect(page.getByTestId("break-gerente")).toHaveCount(0);
});

test("gerente cover choices preserve simple and Shuffle payloads and rejection uses the stored request", async ({ page }) => {
  const data = await workerUI(page, "pending");
  await page.route("**/api/breaks/session", route => route.fulfill({ json: route.request().method() === "GET" ? { role: "manager" } : { kind: "gerente", token: "synthetic-manager", role: "manager", name: "Gerente Ejemplo", idleMs: 60_000 } }));
  const writes: Record<string, unknown>[] = [];
  await page.route("**/api/breaks/manage**", async route => {
    if (route.request().method() === "GET") {
      await route.fulfill({ json: { firstName: "Mara", allowanceMinutes: 60, row: "this", shifts: data.shifts, slots: [], blocked: [], saved: null, pending: data.saved, state: "pending", approval: "gerente", covers: [{ kind: "simple", employeeId: "cover-a", shiftId: "shift-a", firstName: "Sol" }, { kind: "shuffle", moves: [{ employeeId: "cover-b", shiftId: "shift-b", firstName: "Luz" }, { employeeId: "cover-c", shiftId: "shift-c", firstName: "Rio" }] }] } });
    } else { writes.push({ method: route.request().method(), ...route.request().postDataJSON() }); await route.fulfill({ json: { waiting: false, cleared: true } }); }
  });
  await page.goto("/descansos?board=caja");
  for (const digit of "4545") await page.getByTestId(`break-key-${digit}`).click();
  await expect(page.getByTestId("break-gerente")).toBeVisible();
  await expect(page.getByTestId("break-pairing-open")).toHaveCount(0);
  await expect(page.getByTestId("break-date")).toHaveCount(0);
  await page.getByTestId("break-review").first().click();
  await page.locator('[data-testid="descanso-cover"][data-kind="simple"]').click();
  await expect(page.getByTestId("descanso-dialog")).toHaveCount(0);
  expect(writes[0]).toMatchObject({ method: "POST", board: "cocina", employeeId: "a", coverEmployeeId: "cover-a" });
  await page.getByTestId("break-review").first().click();
  await expect(page.locator('[data-testid="descanso-cover"][data-kind="shuffle"]')).toBeVisible();
  await screenshot(page, "07_SIMPLE_AND_SHUFFLE");
  await page.locator('[data-testid="descanso-cover"][data-kind="shuffle"]').click();
  await expect(page.getByTestId("descanso-dialog")).toHaveCount(0);
  expect(writes[1]).toMatchObject({ coverEmployeeId: "cover-b", shuffleEmployeeId: "cover-c" });
  await page.getByTestId("break-review").first().click();
  await page.getByTestId("descanso-clear").click();
  await expect(page.getByTestId("descanso-dialog")).toHaveCount(0);
  expect(writes[2]).toEqual({ method: "DELETE", board: "cocina", employeeId: "a" });
});

test("English approval and all persisted status cards retain full landscape width", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript(() => localStorage.setItem("taco-oasis-locale-v1", "en"));
  const data = await workerUI(page, "reserved");
  await page.goto("/descansos?board=caja");
  await enterWorker(page);
  await expect(page.getByTestId("break-status")).toContainText("Reserved");
  await expect(page.getByTestId("break-status")).toContainText("Approval: gerente required.");
  await screenshot(page, "08_EN_RESERVED");
  for (const [state, label] of [["on-break", "On BREAK"], ["completed", "Completed"], ["ended", "Request ended without a BREAK"]]) {
    data.saved!.state = state;
    if (state === "ended") data.saved!.approval = null;
    await page.getByTestId("break-close").click();
    await enterWorker(page);
    await expect(page.getByTestId("break-status")).toContainText(label);
  }
});

test("a gerente-created pending request updates its status card without claiming completion", async ({ page }) => {
  const data = await workerUI(page);
  await page.route("**/api/breaks/session", route => route.fulfill({ json: route.request().method() === "GET" ? { role: "manager" } : { kind: "gerente", token: "synthetic-manager", role: "manager", name: "Gerente Ejemplo", idleMs: 60_000 } }));
  await page.route("**/api/breaks/manage**", route => route.fulfill({ json: route.request().method() === "GET" ? {
    firstName: "Mara", allowanceMinutes: 60, row: "absent", shifts: data.shifts, slots: data.slots, blocked: [], saved: null, pending: null, state: "absent", covers: [],
  } : { waiting: true, covers: [], message: "Requiere aprobación del gerente." } }));
  await page.goto("/descansos?board=caja");
  for (const digit of "4545") await page.getByTestId(`break-key-${digit}`).click();
  await page.getByTestId("break-review").first().click();
  await page.locator(`[data-testid="descanso-start"][data-start="${iso("2:00 pm")}"]`).click();
  await page.getByTestId("descanso-save").click();
  await expect(page.getByTestId("descanso-dialog")).toContainText("Pendiente · Aprobación: requiere gerente.");
  await expect(page.getByTestId("descanso-dialog")).not.toContainText("Completado");
  await expect(page.getByTestId("descanso-clear")).toHaveText("Rechazar solicitud");
});
