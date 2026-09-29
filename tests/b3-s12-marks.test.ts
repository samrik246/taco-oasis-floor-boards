/**
 * B3 S12: selection marks, default-mandatory dots, Birria 1, Carne hidden.
 */
import { afterAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { GET as abilityGrid } from "@/app/api/admin/abilities/route";
import { PUT as saveColumn } from "@/app/api/admin/ability-columns/route";
import { ABILITY_WORD } from "@/lib/abilities/levels";
import { stationColorClass } from "@/components/board/board-helpers";
import { STATION_COLORS } from "@/lib/admin/validate";
import { chicagoHourStart } from "@/lib/hour-grid";
import { hashManagerCode } from "@/lib/managers/codes";
import { signManagerSession } from "@/lib/managers/session";
import {
  MANDATORY_STATIONS_BY_BOARD,
  eligibilityDots,
  isDefaultMandatory,
  uncoveredMandatory,
} from "@/lib/mandatory";
import { setMandatoryMark } from "@/lib/mandatory-store";
import { stationSolidClass } from "@/lib/schedule/station-codes";
import {
  markForStation,
  openCellOutlineClass,
  selectionMark,
} from "@/lib/selection-mark";

const prisma = new PrismaClient();
const stamp = `b3s12-${Date.now()}`;
const date = "2034-11-06";
const hours = [10, 11, 12];

function authed(token: string, url: string, init?: RequestInit) {
  const headers = new Headers(init?.headers);
  headers.set("x-manager-session", token);
  if (init?.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  return new Request(url, { ...init, headers });
}

describe("B3 S12 selection marks", () => {
  it("K1 maps levels, a missing row, and an absent abilities array", () => {
    expect(selectionMark("forbidden")).toBe("none");
    expect(selectionMark("training")).toBe("dashed");
    expect(selectionMark("ok")).toBe("solid");
    expect(selectionMark("preferred")).toBe("filled");
    expect(markForStation({
      abilities: [],
      stationId: "pdf_tq1r",
      columnDefault: "ok",
    })).toBe("solid");
    expect(markForStation({
      abilities: [],
      stationId: "pdf_pstl",
      columnDefault: "forbidden",
    })).toBe("none");
    expect(markForStation({
      abilities: [{ stationId: "pdf_tq1r", level: "preferred" }],
      stationId: "pdf_tq1r",
      columnDefault: "forbidden",
    })).toBe("filled");
    expect(markForStation({ abilities: undefined, stationId: "pdf_tq1r" })).toBe("none");
    expect(markForStation({ abilities: null, stationId: "pdf_tq1r" })).toBe("none");
    expect(ABILITY_WORD.training).toBe("poco");
  });

  it("an open-cell class is not a painted fill, and a manager outline is one class", () => {
    const colors = STATION_COLORS;
    for (const color of colors) {
      for (const mark of ["none", "dashed", "solid", "filled"] as const) {
        for (const mode of ["rest", "manager", "owner"] as const) {
          const frame = openCellOutlineClass({ mode, mark, color });
          expect(frame.className).not.toContain(stationColorClass(color));
          expect(frame.className).not.toContain(stationSolidClass(color));
        }
      }
      const manager = openCellOutlineClass({ mode: "manager", mark: "filled", color });
      const again = openCellOutlineClass({ mode: "manager", mark: "dashed", color });
      expect(again.className).toBe(manager.className);
      expect(manager.className).toContain("bg-white");
      expect(manager.className).not.toContain("border-dashed");
    }
    const fuerte = openCellOutlineClass({ mode: "owner", mark: "filled", color: "pink" });
    expect(fuerte.wash).toBe(true);
    expect(fuerte.className).toContain("bg-pink-50");
    expect(fuerte.className).not.toContain("bg-pink-200");
  });

  it("K2 dots follow default-mandatory gaps only, and Birria 1 cannot be unmarked", async () => {
    expect(MANDATORY_STATIONS_BY_BOARD.cocina).toEqual(["pdf_tq1r", "pdf_tf1r", "pdf_pr1e", "pdf_br1a", "pdf_guia"]);
    expect(MANDATORY_STATIONS_BY_BOARD.caja).toEqual(["green1", "purple1", "yellow", "nieves", "mana"]);
    expect(isDefaultMandatory("pdf_br1a")).toBe(true);
    expect(isDefaultMandatory("pdf_br2a")).toBe(false);
    expect(isDefaultMandatory("pdf_pstl")).toBe(false);

    const shift = {
      id: "ada",
      date,
      startAt: chicagoHourStart(date, 9).toISOString(),
      endAt: chicagoHourStart(date, 17).toISOString(),
      assignments: [] as { stationId: string; hourStart: string }[],
      employee: { abilities: [] as { stationId: string; level: string }[] },
    };
    const gaps = uncoveredMandatory({
      stationIds: ["pdf_tq1r", "pdf_pstl", "pdf_br1a"],
      hours,
      date,
      shifts: [shift],
    });
    expect(gaps.some((gap) => gap.stationId === "pdf_pstl" && gap.hour === 12)).toBe(true);
    expect(gaps.some((gap) => gap.hour === 10)).toBe(false);
    const dots = eligibilityDots({ gaps, shift, hour: 12, kind: "open" });
    expect(dots.map((dot) => dot.stationId)).toEqual(["pdf_tq1r", "pdf_br1a"]);
    expect(dots.every((dot) => dot.level === "ok")).toBe(true);
    expect(eligibilityDots({ gaps, shift, hour: 10, kind: "open" })).toEqual([]);

    const refused = await setMandatoryMark({
      date,
      stationId: "pdf_br1a",
      on: false,
      actor: { id: "s12", name: "S12", route: "test" },
    });
    expect(refused).toEqual({ ok: false, status: 400, error: "That station is already mandatory" });
  });
});

describe("B3 S12 Carne column default", () => {
  let ownerId = "";

  afterAll(async () => {
    await prisma.abilityColumnSetting.deleteMany({ where: { key: "pdf_crne" } });
    if (ownerId) {
      await prisma.boardChangeLog.deleteMany({ where: { managerId: ownerId } });
      await prisma.manager.deleteMany({ where: { id: ownerId } });
    }
    await prisma.$disconnect();
  });

  it("K6 hides Carne only when no settings row is stored", async () => {
    await prisma.abilityColumnSetting.deleteMany({ where: { key: "pdf_crne" } });
    const owner = await prisma.manager.create({
      data: { name: `${stamp} Owner`, codeHash: hashManagerCode(`${stamp}-owner`), role: "owner" },
    });
    ownerId = owner.id;
    const token = signManagerSession({ id: owner.id, name: owner.name });
    const first = await abilityGrid(authed(token, "http://local/api/admin/abilities?board=cocina"));
    expect(first.status).toBe(200);
    const hidden = await first.json() as { settings: { key: string; hidden: boolean; defaultLevel: string }[] };
    const carne = hidden.settings.filter((row) => row.key === "pdf_crne");
    expect(carne).toEqual([{ key: "pdf_crne", hidden: true, defaultLevel: "ok" }]);

    const shown = await saveColumn(authed(token, "http://local/api/admin/ability-columns", {
      method: "PUT",
      body: JSON.stringify({ key: "pdf_crne", hidden: false }),
    }));
    expect(shown.status).toBe(200);
    const second = await abilityGrid(authed(token, "http://local/api/admin/abilities?board=cocina"));
    const body = await second.json() as { settings: { key: string; hidden: boolean; defaultLevel: string }[] };
    expect(body.settings.filter((row) => row.key === "pdf_crne")).toEqual([
      { key: "pdf_crne", hidden: false, defaultLevel: "ok" },
    ]);
  });
});
