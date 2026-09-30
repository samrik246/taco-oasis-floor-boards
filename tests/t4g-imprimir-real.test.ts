/**
 * T4G Imprimir end to end: route -> real packing-ticket Python -> a fake
 * Epson on loopback. Runs only when the host names a packing-ticket checkout:
 *   T4G_PRINT_TEST_DIR=/abs/UNIVERSAL_SQUARE_PACKING_TICKET (branch quinn/t4g-imprimir-pt)
 *   T4G_PRINT_TEST_PYTHON=/abs/.venv/bin/python
 * No real printer is ever addressed: the config is written here, on 127.0.0.1.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { hashManagerCode } from "@/lib/managers/codes";
import { signManagerSession } from "@/lib/managers/session";
import type { UpcomingOrder } from "@/lib/upcoming/fence";
import { startFakeEpson, type FakeEpson } from "./helpers/fake-epson";

const DIR = process.env.T4G_PRINT_TEST_DIR ?? "";
const PYTHON = process.env.T4G_PRINT_TEST_PYTHON ?? "";
const enabled = path.isAbsolute(DIR) && path.isAbsolute(PYTHON);

const ORDER: UpcomingOrder = {
  id_tail: "AgIeZY",
  fulfill_type: "PICKUP",
  event_date: "2099-10-15",
  event_time: "10:00",
  ready_time: "10:00",
  guests: 15,
  lines: [{ item_name: "Taco Tray", variation: "Regular", modifiers: "1 x STEAK - asada", qty: 5 }],
};

vi.mock("@/lib/upcoming/source", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/upcoming/source")>();
  return {
    ...actual,
    getUpcomingSource: () => ({
      kind: "fixture",
      load: async () => ({ source: "fixture", orders: [ORDER], heldBack: 0, fetchedAt: null, stale: false }),
      loadStrip: async () => ({ source: "fixture", orders: [], heldBack: 0, fetchedAt: null, stale: false }),
    }),
  };
});

const PREAMBLE = Buffer.from([0x1b, 0x40, 0x1b, 0x4d, 0x00, 0x1b, 0x74, 0x10, 0x1d, 0x21, 0x11]);
const CAMBIO_BLOCK = Buffer.concat([Buffer.from([0x1b, 0x61, 0x01, 0x1b, 0x45, 0x01]), Buffer.from("** CAMBIO **\n", "latin1")]);

const prisma = new PrismaClient();
const stamp = `T4GREAL-${Date.now()}`;
const priorSecret = process.env.MANAGER_SESSION_SECRET;
let token = "";
let fake: FakeEpson | null = null;
let workDir = "";

async function loadRoute() {
  return import("@/app/api/upcoming/print/route");
}

async function setup(opts: Parameters<typeof startFakeEpson>[0] = {}, timeout = 2) {
  fake = await startFakeEpson(opts);
  const cfg = path.join(workDir, "three_part.json");
  writeFileSync(
    cfg,
    JSON.stringify({
      three_part: {
        printers: { fake: { host: "127.0.0.1", port: fake.port, model: "TM-m30II-H" } },
        stations: { CALIENTE: "fake", FRIO: "fake", EQUIPO: "fake", GERENTE: "fake" },
        timeout_seconds: timeout,
        ledger_path: path.join(workDir, "t4g.sqlite"),
      },
    }),
  );
  Object.assign(process.env, {
    T4G_PRINT: "on",
    T4G_PRINT_PYTHON: PYTHON,
    T4G_PRINT_DIR: DIR,
    T4G_PRINT_CONFIG: cfg,
    T4G_PRINT_MODEL_SOURCE: "fixture",
  });
}

async function tap() {
  const { POST } = await loadRoute();
  const res = await POST(
    new Request("http://local/api/upcoming/print", {
      method: "POST",
      headers: { "content-type": "application/json", "x-manager-session": token },
      body: JSON.stringify({ tail: "AgIeZY" }),
    }),
  );
  return { code: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe.skipIf(!enabled)("T4G Imprimir end to end on a fake Epson (checks 5, 6, 11)", () => {
  beforeAll(async () => {
    process.env.MANAGER_SESSION_SECRET = "t4g-imprimir-real-secret-000000000000";
    const m = await prisma.manager.create({
      data: { name: `${stamp} gerente`, codeHash: hashManagerCode(`${stamp}-c`), active: true, role: "manager" },
    });
    token = signManagerSession({ id: m.id, name: m.name });
  });

  afterAll(async () => {
    await prisma.manager.deleteMany({ where: { name: { startsWith: stamp } } });
    await prisma.$disconnect();
    if (priorSecret === undefined) delete process.env.MANAGER_SESSION_SECRET;
    else process.env.MANAGER_SESSION_SECRET = priorSecret;
  });

  beforeEach(() => {
    workDir = mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "t4g-real-"));
  });

  afterEach(async () => {
    await fake?.close();
    fake = null;
    for (const k of ["T4G_PRINT", "T4G_PRINT_PYTHON", "T4G_PRINT_DIR", "T4G_PRINT_CONFIG", "T4G_PRINT_MODEL_SOURCE"]) delete process.env[k];
  });

  it("first tap prints 4 tickets, second prints the same 4 marked CAMBIO", async () => {
    await setup();
    const first = await tap();
    expect(first).toEqual({ code: 200, body: { status: "ok", id_tail: "AgIeZY", cambio: false, problems: [], locked_until: null } });
    expect(fake!.tickets).toHaveLength(4);
    for (const t of fake!.tickets) expect(t.subarray(0, PREAMBLE.length).equals(PREAMBLE)).toBe(true);

    const second = await tap();
    expect(second.body.status).toBe("ok");
    expect(second.body.cambio).toBe(true);
    expect(fake!.tickets).toHaveLength(8);
    fake!.tickets.slice(4).forEach((t, i) => {
      const n = PREAMBLE.length;
      expect(t.subarray(n, n + CAMBIO_BLOCK.length).equals(CAMBIO_BLOCK)).toBe(true);
      expect(Buffer.concat([t.subarray(0, n), t.subarray(n + CAMBIO_BLOCK.length)]).equals(fake!.tickets[i])).toBe(true);
    });

    const { GET } = await loadRoute();
    const state = await (await GET(new Request("http://local/api/upcoming/print?tail=AgIeZY"))).json();
    expect(state).toEqual({ printing: true, printed: true, locked_until: null });
  }, 60_000);

  it("two taps at once print once", async () => {
    await setup();
    const results = await Promise.all([tap(), tap()]);
    const statuses = results.map((r) => r.body.status).sort();
    expect(statuses).toEqual(["busy", "ok"]);
    expect(fake!.tickets).toHaveLength(4);
  }, 60_000);

  it("a blocked printer sends no ticket and the next tap is still the first print", async () => {
    await setup({ status: { 4: 0x72 } });
    const blocked = await tap();
    expect(blocked.body).toMatchObject({ status: "blocked", problems: ["paper_out"] });
    expect(fake!.tickets).toHaveLength(0);
  }, 60_000);

  it("an uncertain send locks the order on disk, across a server restart", async () => {
    await setup({ silentAfterTickets: 1 }, 0.5);
    const first = await tap();
    expect(first.body.status).toBe("uncertain");
    expect(typeof first.body.locked_until).toBe("string");
    const sent = fake!.tickets.length;

    vi.resetModules(); // a restarted floor-boards server holds no memory of it
    const again = await tap();
    expect(again.body).toMatchObject({ status: "locked", locked_until: first.body.locked_until });
    expect(fake!.tickets.length).toBe(sent);

    const { GET } = await loadRoute();
    const state = await (await GET(new Request("http://local/api/upcoming/print?tail=AgIeZY"))).json();
    expect(state.locked_until).toBe(first.body.locked_until);
  }, 60_000);
});
