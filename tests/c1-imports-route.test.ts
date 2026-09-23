import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { POST as postImport } from "@/app/api/imports/route";
import { signManagerSession } from "@/lib/managers/session";
import { hashManagerCode } from "@/lib/managers/codes";
import {
  dbSnapshot,
  resetScheduleTables,
  syntheticCsv,
  type SyntheticRow,
} from "./helpers/synthetic-schedule";

const prisma = new PrismaClient();
// A date in the future, so every hour is still ahead of the real clock.
const D = "2031-01-06";

const row = (employeeId: string, firstName: string, start: string, end: string, position = "Caja - Regular"): SyntheticRow => ({
  position,
  firstName,
  lastName: "Muestra",
  employeeId,
  date: D,
  start,
  end,
});
const MORNING = [row("7001", "Greta", "8:00 am", "4:00 pm"), row("7002", "Hector", "9:00 am", "5:00 pm", "Cocina")];
const AFTERNOON = [row("7001", "Greta", "8:00 am", "2:00 pm"), row("7002", "Hector", "9:00 am", "5:00 pm", "Cocina")];

let token = "";

function upload(rows: SyntheticRow[] | Buffer, fields: Record<string, string> = {}, name = "export.csv") {
  const form = new FormData();
  const body = Buffer.isBuffer(rows) ? rows : syntheticCsv(rows);
  form.set("file", new File([new Uint8Array(body)], name, { type: "text/csv" }));
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return postImport(
    new Request("http://local/api/imports", {
      method: "POST",
      body: form,
      headers: { "x-manager-session": token },
    }),
  );
}

describe("POST /api/imports preview / commit", () => {
  beforeAll(async () => {
    await resetScheduleTables(prisma);
    const manager = await prisma.manager.create({
      data: { name: "C1 Test Manager", codeHash: hashManagerCode("7788"), active: true },
    });
    token = signManagerSession({ id: manager.id, name: manager.name });
  });
  afterAll(async () => {
    await prisma.manager.deleteMany({ where: { name: "C1 Test Manager" } });
    await prisma.$disconnect();
  });

  it("a file of new dates previews without confirm, then commits", async () => {
    const preview = await upload(MORNING, { mode: "preview" });
    expect(preview.status).toBe(200);
    const p = await preview.json();
    expect(p.needsConfirm).toBe(false);
    const commit = await upload(MORNING, { mode: "commit", fingerprint: p.fingerprint, planDigest: p.planDigest });
    expect(commit.status).toBe(200);
    expect((await commit.json()).rowCount).toBe(2);
  });

  it("a file touching an imported date needs the preview (409 without it)", async () => {
    const before = await dbSnapshot(prisma);
    const res = await upload(AFTERNOON);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("PREVIEW_REQUIRED");
    expect(await dbSnapshot(prisma)).toBe(before);
  });

  it("A10: a malformed afternoon file -> 400 and the database unchanged", async () => {
    const before = await dbSnapshot(prisma);
    const broken = Buffer.from("Position,First Name\nCaja - Regular,Greta\n", "utf8");
    for (const mode of ["preview", "commit"]) {
      const res = await upload(broken, { mode, fingerprint: "0".repeat(64), planDigest: "0".repeat(64) });
      expect(res.status).toBe(400);
    }
    const badTime = Buffer.from(
      syntheticCsv([row("7001", "Greta", "8:00 am", "25:00 pm")]).toString("utf8"),
      "utf8",
    );
    expect((await upload(badTime, { mode: "preview" })).status).toBe(400);
    expect(await dbSnapshot(prisma)).toBe(before);
  });

  it("afternoon preview then commit applies the change; commit needs both tokens", async () => {
    const preview = await (await upload(AFTERNOON, { mode: "preview" })).json();
    expect(preview.needsConfirm).toBe(true);
    expect(preview.dates[0]).toMatchObject({ date: D, changed: 1, unchanged: 1 });
    expect((await upload(AFTERNOON, { mode: "commit" })).status).toBe(400);
    const res = await upload(AFTERNOON, {
      mode: "commit",
      fingerprint: preview.fingerprint,
      planDigest: preview.planDigest,
    });
    expect(res.status).toBe(200);
    const greta = await prisma.shift.findFirstOrThrow({ where: { employee: { externalId: "7001" } } });
    expect(greta.endAt.toISOString()).toBe(new Date("2031-01-06T20:00:00.000Z").toISOString());
    // A3 through the route: same file again -> refused with "nothing changed".
    const again = await upload(AFTERNOON, { mode: "preview" });
    expect(again.status).toBe(400);
    expect((await again.json()).error).toMatch(/Nothing changed/);
  });
});
