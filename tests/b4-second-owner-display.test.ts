import { describe, expect, it } from "vitest";
import { describeBreakCover } from "@/lib/breaks/cover-positions";
import { listBreakCovers } from "@/lib/breaks/covers";
import { breakChoiceTone, choiceUnavailableLabel } from "@/lib/breaks/display";
import { breakQuarterFaces, preferredBreakLength } from "@/lib/breaks/picker-steps";
import { blockedBreakQuarters } from "@/lib/breaks/mine";
import { chicagoDateTime } from "@/lib/time";
import { boardStationLabel } from "@/lib/i18n";
import type { SliceOverlay } from "@/lib/slices/day-slices";
const date = "2046-06-06";
const at = (s: string) => chicagoDateTime(date, s);
const stars = ["pdf_tq1r", "pdf_tf1r"];
const shift = (id: string, board = "cocina") => ({ id, employeeId: id, board, startAt: at("8:00 am"), endAt: at("4:00 pm"), superseded: false, boardRemoved: false });
const paint = (id: string, stationId: string) => ({ employeeId: id, shiftId: id, stationId, hourStart: at("2:00 pm") });
const base = { date, board: "cocina" as const, employeeId: "Mara", startAt: at("2:00 pm"), endAt: at("2:30 pm"),
  shifts: [shift("Mara"), shift("Luz"), shift("Sol")], paints: [paint("Mara", stars[0]), paint("Luz", stars[1])],
  breaks: [], overlays: [] as SliceOverlay[], starStationIds: stars, abilities: [], names: new Map(["Mara", "Luz", "Sol"].map(id => [id,id])) };

describe("second owner cover explanations", () => {
  it("reports every effective move in a two-person Shuffle", () => {
    const cover = listBreakCovers(base).find(c => c.kind === "shuffle")!;
    expect(cover).toBeDefined();
    expect(describeBreakCover(base, cover).positions).toEqual([{
      startAt: at("2:00 pm").toISOString(), endAt: at("2:30 pm").toISOString(), vacatedStationId: stars[0], moves: [
        { employeeId: "Luz", firstName: "Luz", fromStationId: stars[1], toStationId: stars[0] },
        { employeeId: "Sol", firstName: "Sol", fromStationId: null, toStationId: stars[1] },
      ],
    }]);
  });
  it("splits changing effective stations by quarter and ignores stale paint under Switch", () => {
    const input = { ...base, shifts: [...base.shifts, shift("Rio")], paints: [...base.paints, paint("Sol", "pdf_tq2r"), paint("Rio", "pdf_tf2r")],
      overlays: [
        { id: "ask-switch", kind: "switch" as const, employeeId: "Mara", partnerEmployeeId: "Luz", fromStationId: stars[0], stationId: stars[1], startAt: at("2:15 pm"), endAt: at("2:30 pm") },
        { id: "cover-switch", kind: "switch" as const, employeeId: "Sol", partnerEmployeeId: "Rio", fromStationId: "pdf_tq2r", stationId: "pdf_tf2r", startAt: at("2:15 pm"), endAt: at("2:30 pm") },
      ], names: new Map([...base.names, ["Rio", "Rio"]]) };
    const cover = listBreakCovers(input).find(c => c.kind === "simple" && c.employeeId === "Sol")!;
    expect(cover).toBeDefined();
    const positions = describeBreakCover(input, cover).positions;
    expect(positions).toHaveLength(2);
    expect(positions[0]).toMatchObject({ vacatedStationId: stars[0], moves: [{ fromStationId: "pdf_tq2r", toStationId: stars[0] }] });
    expect(positions[1]).toMatchObject({ startAt: at("2:15 pm").toISOString(), vacatedStationId: stars[1], moves: [{ fromStationId: "pdf_tf2r", toStationId: stars[1] }] });
  });
  it("uses the other board's effective seat and saved label", () => {
    const input = { ...base, shifts: [shift("Mara"), shift("Luz"), shift("Sol", "caja")], paints: [...base.paints, paint("Sol", "caja1")],
      overlays: [] };
    const cover = listBreakCovers(input).find(c => c.kind === "simple")!;
    const positions = describeBreakCover(input, cover).positions;
    expect(positions[0].moves[0]).toMatchObject({ fromStationId: "caja1", toStationId: stars[0] });
    expect(boardStationLabel("en", stars[0], [{ id: stars[0], label: "Custom station" }])).toBe("Custom station");
  });
});

describe("truthful start colors", () => {
  it("follows the displayed duration and keeps unknown unavailable distinct from capacity", () => {
    const short = { startAt: at("2:00 pm").toISOString(), endAt: at("2:15 pm").toISOString(), approval: "automatic" as const };
    const long = { ...short, endAt: at("2:30 pm").toISOString(), approval: "gerente" as const };
    expect(preferredBreakLength([short, long], 30)).toEqual(long);
    expect(breakChoiceTone(null, long)).toBe("gerente");
    expect(breakChoiceTone(null, short)).toBe("automatic");
    const faces = breakQuarterFaces({ shifts: [{ startAt: at("8:10 am").toISOString(), endAt: at("8:45 am").toISOString() }], slots: [], blocked: [{ startAt: at("8:30 am").toISOString(), reason: "overlap" }] });
    expect(faces.map(face => breakChoiceTone(face.reason, null))).toEqual(["unavailable", "unavailable", "capacity"]);
    for (const locale of ["es", "en"] as const) expect(choiceUnavailableLabel(locale, "Ocupado")).toMatch(/Límite|capacity/);
  });
  it("capacity excludes ended requests and blackouts take precedence", () => {
    const shifts = [shift("Mara")];
    const row = { board: "cocina", startAt: at("2:00 pm"), endAt: at("2:30 pm"), status: "booked" };
    expect(blockedBreakQuarters({ date, board: "cocina", shifts, otherBreaks: [row, { ...row, status: "ended" }] }).filter(r => r.reason === "overlap")).toHaveLength(0);
    expect(blockedBreakQuarters({ date, board: "cocina", shifts, otherBreaks: [row, row] }).filter(r => r.reason === "overlap")).toHaveLength(2);
    const blocked = blockedBreakQuarters({ date: "2046-06-04", board: "cocina", shifts: [{ ...shifts[0], startAt: chicagoDateTime("2046-06-04", "8:00 am"), endAt: chicagoDateTime("2046-06-04", "4:00 pm") }], otherBreaks: [row, row] });
    expect(blocked.filter(r => r.reason === "blackout").length).toBeGreaterThan(0);
  });
});
