/**
 * T4G Imprimir: the route's gates and the child contract, with the child
 * process faked. No printer, no Python. The real-Python path is in
 * t4g-imprimir-real.test.ts.
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { hashManagerCode } from "@/lib/managers/codes";
import { signManagerSession } from "@/lib/managers/session";
import { signStaffSession } from "@/lib/breaks/session";
import type { UpcomingOrder } from "@/lib/upcoming/fence";

type ExecCall = { file: string; args: string[]; options: { env: Record<string, string>; cwd: string; timeout: number }; stdin: string };

const child = vi.hoisted(() => ({
  calls: [] as ExecCall[],
  reply: ((): { error: Error | null; stdout: string; stderr: string } => ({ error: null, stdout: "", stderr: "" })) as (call: ExecCall) => { error: Error | null; stdout: string; stderr: string },
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { PassThrough } = await import("node:stream");
  return {
    ...actual,
    execFile: (
      file: string,
      args: string[],
      options: ExecCall["options"],
      cb: (e: Error | null, out: string, err: string) => void,
    ) => {
      const stdin = new PassThrough();
      let body = "";
      stdin.on("data", (d: Buffer) => (body += d.toString("utf8")));
      stdin.on("finish", () => {
        const call = { file, args, options, stdin: body };
        child.calls.push(call);
        const r = child.reply(call);
        setImmediate(() => cb(r.error, r.stdout, r.stderr));
      });
      return { stdin };
    },
  };
});

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

const { GET, POST } = await import("@/app/api/upcoming/print/route");
const { childEnv, printConfigFromEnv, runPrint } = await import("@/lib/print/t4g-print");
const { PrintButtonView, noticeText } = await import("@/components/next/PrintButton");
const { NEXT_COPY } = await import("@/components/next/next-copy");
const { OrderDetail } = await import("@/components/next/OrderDetail");

const prisma = new PrismaClient();
const stamp = `T4GPRINT-${Date.now()}`;
const ROOT = process.cwd();
const PRINT_ENV = {
  T4G_PRINT: "on",
  T4G_PRINT_PYTHON: "/opt/packing-ticket/.venv/bin/python",
  T4G_PRINT_DIR: "/opt/packing-ticket",
  T4G_PRINT_CONFIG: "/opt/packing-ticket/three_part.json",
  T4G_PRINT_MODEL_SOURCE: "fixture",
};
let managerToken = "";
const priorSecret = process.env.MANAGER_SESSION_SECRET;

function okLine(extra: Record<string, unknown> = {}) {
  return JSON.stringify({ status: "ok", id_tail: "AgIeZY", cambio: false, problems: [], locked_until: null, tickets: [], ...extra }) + "\n";
}

function post(body: unknown, headers: Record<string, string> = {}) {
  return POST(
    new Request("http://local/api/upcoming/print", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

beforeAll(async () => {
  process.env.MANAGER_SESSION_SECRET = "t4g-imprimir-test-secret-0000000000000";
  const manager = await prisma.manager.create({
    data: { name: `${stamp} gerente`, codeHash: hashManagerCode(`${stamp}-code`), active: true, role: "manager" },
  });
  managerToken = signManagerSession({ id: manager.id, name: manager.name });
});

afterAll(async () => {
  await prisma.manager.deleteMany({ where: { name: { startsWith: stamp } } });
  await prisma.$disconnect();
  if (priorSecret === undefined) delete process.env.MANAGER_SESSION_SECRET;
  else process.env.MANAGER_SESSION_SECRET = priorSecret;
});

beforeEach(() => {
  child.calls.length = 0;
  child.reply = () => ({ error: null, stdout: okLine(), stderr: "" });
  Object.assign(process.env, PRINT_ENV);
  process.env.BUZZ_PRIVATE_KEY = "nsec-should-never-reach-the-child";
  process.env.C1_NEXT_KEY = "c1-key-should-never-reach-the-child";
});

afterEach(() => {
  for (const key of Object.keys(PRINT_ENV)) delete process.env[key];
  delete process.env.BUZZ_PRIVATE_KEY;
  delete process.env.C1_NEXT_KEY;
});

describe("route gates (checks 1, 2, 10)", () => {
  it("404 when printing is off, before anything else", async () => {
    delete process.env.T4G_PRINT;
    const res = await post({ tail: "AgIeZY" }, { "x-manager-session": managerToken });
    expect(res.status).toBe(404);
    expect(child.calls).toHaveLength(0);
    expect(await (await GET(new Request("http://local/api/upcoming/print?tail=AgIeZY"))).json()).toEqual({ printing: false });
  });

  it("401 without a manager session", async () => {
    const res = await post({ tail: "AgIeZY" });
    expect(res.status).toBe(401);
    expect(child.calls).toHaveLength(0);
  });

  it("403 for a staff session, in the staff header or the manager header", async () => {
    const staff = signStaffSession({ employeeId: "emp-1", board: "cocina" });
    const variants: Record<string, string>[] = [{ "x-staff-session": staff }, { "x-manager-session": staff }];
    for (const headers of variants) {
      const res = await post({ tail: "AgIeZY" }, headers);
      expect(res.status).toBe(403);
    }
    expect(child.calls).toHaveLength(0);
  });

  it("400 for a bad tail", async () => {
    for (const body of [{ tail: "../x" }, { tail: "" }, { tail: "abc" }, {}, "not json"]) {
      const res = await post(body, { "x-manager-session": managerToken });
      expect(res.status).toBe(400);
    }
    expect(child.calls).toHaveLength(0);
  });

  it("404 for a tail not in the current C1 snapshot", async () => {
    const res = await post({ tail: "zzzz99" }, { "x-manager-session": managerToken });
    expect(res.status).toBe(404);
    expect(child.calls).toHaveLength(0);
  });

  it("refuses before Python when the model is missing or its tail does not match", async () => {
    const orig = process.cwd();
    const spy = vi.spyOn(process, "cwd").mockReturnValue(path.join(orig, "tests"));
    try {
      const res = await post({ tail: "AgIeZY" }, { "x-manager-session": managerToken });
      expect(res.status).toBe(502);
      expect((await res.json()).status).toBe("refused");
    } finally {
      spy.mockRestore();
    }
    const { loadPrintModel } = await import("@/lib/print/t4g-print");
    const cfg = printConfigFromEnv()!;
    await expect(loadPrintModel("hj35YY", cfg)).rejects.toThrow("no model");
    const tmp = mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "t4g-model-"));
    mkdirSync(path.join(tmp, "fixtures", "square-next", "print-models"), { recursive: true });
    writeFileSync(path.join(tmp, "fixtures", "square-next", "print-models", "AgIeZY.json"), JSON.stringify({ idTail: "OTHER1" }));
    await expect(loadPrintModel("AgIeZY", cfg, tmp)).rejects.toThrow("model tail mismatch");
    expect((await loadPrintModel("AgIeZY", cfg)).idTail).toBe("AgIeZY");
    expect(child.calls).toHaveLength(0);
  });
});

describe("child contract (checks 3, 7, 12)", () => {
  it("argv array, model on stdin, scrubbed env, status only back", async () => {
    child.reply = () => ({ error: null, stdout: okLine(), stderr: "SEND order=AgIeZY ... ORDEN PARA Fixture" });
    const res = await post({ tail: "AgIeZY" }, { "x-manager-session": managerToken });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ status: "ok", id_tail: "AgIeZY", cambio: false, problems: [], locked_until: null });
    expect(text).not.toMatch(/Fixture|ORDEN|rows|SEND/);

    expect(child.calls).toHaveLength(1);
    const call = child.calls[0];
    expect(call.file).toBe(PRINT_ENV.T4G_PRINT_PYTHON);
    expect(call.args).toEqual(["-m", "packing_ticket.three_part", "--model", "-", "--config", PRINT_ENV.T4G_PRINT_CONFIG]);
    expect(call.options.cwd).toBe(PRINT_ENV.T4G_PRINT_DIR);
    expect(call.options.timeout).toBe(30_000);
    expect(JSON.parse(call.stdin).idTail).toBe("AgIeZY");
    expect(Object.keys(call.options.env).sort()).toEqual(["LANG", "PATH", "PYTHONIOENCODING", "PYTHONPATH"]);
    expect(JSON.stringify(call.options.env)).not.toMatch(/BUZZ|nsec|C1|c1-key|MANAGER/);
  });

  it("non-zero exit, timeout, two lines, junk, or a foreign tail is uncertain, never ok", async () => {
    const cfg = printConfigFromEnv()!;
    const model = { idTail: "AgIeZY" };
    const cases: Array<() => { error: Error | null; stdout: string; stderr: string }> = [
      () => ({ error: Object.assign(new Error("exit 1"), { code: 1 }), stdout: okLine(), stderr: "" }),
      () => ({ error: Object.assign(new Error("timeout"), { killed: true, signal: "SIGTERM" }), stdout: "", stderr: "" }),
      () => ({ error: null, stdout: okLine() + okLine(), stderr: "" }),
      () => ({ error: null, stdout: "Traceback...\n", stderr: "" }),
      () => ({ error: null, stdout: JSON.stringify({ status: "printed" }) + "\n", stderr: "" }),
      () => ({ error: null, stdout: okLine({ id_tail: "OTHER1" }), stderr: "" }),
    ];
    for (const reply of cases) {
      child.reply = reply;
      const out = await runPrint(model, "AgIeZY", cfg);
      expect(out.status).toBe("uncertain");
    }
  });

  it("passes blocked problems and the lock time through, and nothing else", async () => {
    child.reply = () => ({
      error: null,
      stdout: okLine({ status: "blocked", problems: ["paper_out", "Begoña"], locked_until: "x", secret: "y" }),
      stderr: "",
    });
    const out = await runPrint({ idTail: "AgIeZY" }, "AgIeZY", printConfigFromEnv()!);
    expect(out).toEqual({ status: "blocked", id_tail: "AgIeZY", cambio: false, problems: ["paper_out"], locked_until: null });
  });

  it("childEnv is an allow-list", () => {
    process.env.BUZZ_AUTH_TAG = "tag";
    try {
      expect(childEnv(printConfigFromEnv()!)).toEqual({
        PATH: "/usr/bin:/bin",
        PYTHONPATH: PRINT_ENV.T4G_PRINT_DIR,
        PYTHONIOENCODING: "utf-8",
        LANG: "en_US.UTF-8",
      });
    } finally {
      delete process.env.BUZZ_AUTH_TAG;
    }
  });

  it("printing stays off when any setting is missing or relative", () => {
    const base = { ...PRINT_ENV };
    expect(printConfigFromEnv(base)).not.toBeNull();
    expect(printConfigFromEnv({ ...base, T4G_PRINT: "1" })).toBeNull();
    expect(printConfigFromEnv({ ...base, T4G_PRINT_DIR: "packing-ticket" })).toBeNull();
    expect(printConfigFromEnv({ ...base, T4G_PRINT_CONFIG: undefined })).toBeNull();
    expect(printConfigFromEnv({ ...base, T4G_PRINT_MODEL_SOURCE: "sheet" })).toBeNull();
  });

  it("GET reads the ledger through --status and never prints", async () => {
    child.reply = () => ({ error: null, stdout: JSON.stringify({ id_tail: "AgIeZY", printed: true, locked_until: null }) + "\n", stderr: "" });
    const res = await GET(new Request("http://local/api/upcoming/print?tail=AgIeZY"));
    expect(await res.json()).toEqual({ printing: true, printed: true, locked_until: null });
    expect(child.calls[0].args).toContain("--status");
    expect(child.calls[0].args).not.toContain("--model");
  });
});

describe("tablet view (check 4)", () => {
  const t = NEXT_COPY.es;

  it("the three states read exactly as planned", () => {
    expect(noticeText({ kind: "ok" }, t)).toBe("Enviado a la impresora morada. Revisa que salieron 4 tickets.");
    expect(noticeText({ kind: "blocked", problems: ["paper_out"] }, t)).toBe(
      "No imprimió: sin papel. Arréglala y toca Imprimir otra vez.",
    );
    expect(noticeText({ kind: "blocked", problems: ["cover_open"] }, t)).toContain("tapa abierta");
    expect(noticeText({ kind: "blocked", problems: ["offline"] }, t)).toContain("apagada");
    expect(noticeText({ kind: "blocked", problems: [] }, t)).toContain("no responde");
    expect(noticeText({ kind: "uncertain" }, t)).toBe("Revisa la impresora, no vuelvas a tocar.");
    expect(noticeText({ kind: "busy" }, t)).toBe("Ya se está imprimiendo.");
  });

  it("uncertain shows no button; blocked keeps it; printed reads Reimprimir (CAMBIO)", () => {
    const render = (notice: Parameters<typeof PrintButtonView>[0]["notice"], printed = false) =>
      renderToStaticMarkup(createElement(PrintButtonView, { t, printed, busy: false, notice, onTap: () => undefined }));
    const uncertain = render({ kind: "uncertain" }, true);
    expect(uncertain).toContain("Revisa la impresora, no vuelvas a tocar.");
    expect(uncertain).not.toContain("t4g-print-button");
    expect(render({ kind: "blocked", problems: ["paper_out"] })).toContain("t4g-print-button");
    expect(render(null)).toContain(">Imprimir<");
    expect(render({ kind: "ok" }, true)).toContain("Reimprimir (CAMBIO)");
  });

  it("the board strip never renders the print slot", () => {
    const slot = createElement("div", { "data-testid": "slot-marker" });
    const base = { order: ORDER, columns: { fulfill: true, ready: true, guests: true, modifiers: true }, t, locale: "es" as const, today: "2099-10-15" };
    expect(renderToStaticMarkup(createElement(OrderDetail, { ...base, printSlot: slot }))).toContain("slot-marker");
    expect(renderToStaticMarkup(createElement(OrderDetail, { ...base, surface: "board", printSlot: slot }))).not.toContain("slot-marker");
  });
});

describe("no printer address in floor-boards (check 13)", () => {
  it("no source, fixture or test file names the purple printer address", () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (["node_modules", ".next", ".git"].includes(name)) continue;
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx|js|mjs|cjs|json|md)$/.test(name) && readFileSync(full, "utf8").includes("192.168.1." + "169")) hits.push(full);
      }
    };
    for (const dir of ["src", "fixtures", "tests", "e2e", "docs", "scripts"]) walk(path.join(ROOT, dir));
    expect(hits).toEqual([]);
  });
});
