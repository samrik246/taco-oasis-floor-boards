import { offeredBreakSlots, blockedBreakQuarters } from "../../src/lib/breaks/mine";
import { assessStarGate } from "../../src/lib/slices/break-gate";
import { listBreakCovers, numberedSeatCover } from "../../src/lib/breaks/covers";
import { MANDATORY_STATIONS_BY_BOARD } from "../../src/lib/mandatory";
import { chicagoDateTime } from "../../src/lib/time";

/** Synthetic eight-hour crew. Review options use the production placement/coverage rules. */
export function reviewScenario(date: string) {
  const at = (time: string) => chicagoDateTime(date, time);
  const stars = [...MANDATORY_STATIONS_BY_BOARD.cocina];
  const assignments = [
    ["cover-b", "pdf_tq1r"], ["example-f", "pdf_tf1r"], ["example-p", "pdf_pr1e"],
    ["example-b", "pdf_br1a"], ["a", "pdf_guia"], ["cover-a", null], ["cover-c", null],
  ] as const;
  const shifts = assignments.map(([employeeId]) => ({ id: `shift-${employeeId}`, employeeId, board: "cocina", startAt: at("8:00 am"), endAt: at("4:00 pm"), superseded: false, boardRemoved: false }));
  const paints = assignments.flatMap(([employeeId, stationId]) => stationId ? Array.from({ length: 8 }, (_, i) => ({ employeeId, shiftId: `shift-${employeeId}`, stationId, hourStart: at(`${(8 + i) % 12 || 12}:00 ${8 + i < 12 ? "am" : "pm"}`) })) : []);
  const base = { date, board: "cocina" as const, employeeId: "a", shifts, paints, breaks: [], overlays: [], starStationIds: stars,
    abilities: [
      { employeeId: "cover-a", stationId: "pdf_guia", level: "ok" },
      { employeeId: "cover-b", stationId: "pdf_guia", level: "ok" },
      { employeeId: "cover-c", stationId: "pdf_tq1r", level: "ok" },
    ], defaults: new Map(stars.map(id => [id, "forbidden"])), names: new Map([["a", "Mara"], ["cover-a", "Sol"], ["cover-b", "Luz"], ["cover-c", "Rio"]]) };
  const placement = { date, board: "cocina" as const, shifts: shifts.filter(s => s.employeeId === "a"), otherBreaks: [] };
  const slots = offeredBreakSlots(placement).flatMap(slot => {
    const input = { ...base, startAt: new Date(slot.startAt), endAt: new Date(slot.endAt) };
    const gate = assessStarGate(input);
    if (!("code" in gate)) return [{ ...slot, board: "cocina", approval: "automatic" }];
    if (gate.code !== "NEEDS_COVER") return [];
    // Guia has no numbered-seat partner. Fail loudly if that contract ever changes.
    if (numberedSeatCover(input)) throw new Error("Review crew unexpectedly has automatic numbered cover");
    return [{ ...slot, board: "cocina", approval: "gerente" }];
  });
  const covers = listBreakCovers({ ...base, startAt: at("2:00 pm"), endAt: at("2:30 pm") });
  return { shifts: placement.shifts.map(s => ({ board: s.board, startAt: s.startAt.toISOString(), endAt: s.endAt.toISOString() })), slots, blocked: blockedBreakQuarters(placement), covers };
}
