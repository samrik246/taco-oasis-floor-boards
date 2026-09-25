/**
 * Same-day re-import planner (C1 step 5). Pure: no database access.
 *
 * The file is authoritative for every date it contains; dates not in the file
 * are untouched. Per date, old and new shifts are matched by
 * (externalId, sourcePosition). Equal times are unchanged; a paired shift with
 * other times is changed in place when every started, assigned hour still
 * overlaps the new window (history case 1), otherwise it is replaced: the old
 * shift is superseded and a new one added (history case 2). Leftovers are
 * added or removed (removed = superseded). A unique replacement of one
 * person's shift by another person's identical date, board, position and
 * window inherits future station hours. Started hours are history and are
 * never deleted. A future assignment the new file invalidates is listed
 * (station + hour, no names) and removed on Confirm.
 */
import { createHash } from "node:crypto";
import type { ParsedShift } from "@/lib/parser/schedule-parser";
import { chicagoHourOf } from "@/lib/hour-grid";
import { isHourInShift, shiftOverlapMinutes } from "@/lib/rules/shift-window";

export type ExistingAssignment = {
  id: string;
  stationId: string;
  hourStart: Date;
  hourEnd: Date;
};

export type ExistingShift = {
  id: string;
  externalId: string;
  date: string;
  startAt: Date;
  endAt: Date;
  sourcePosition: string;
  board: string;
  assignments: ExistingAssignment[];
};

export type PlanAction =
  | { kind: "unchanged"; old: ExistingShift }
  | { kind: "changed"; old: ExistingShift; next: ParsedShift; removeAssignments: ExistingAssignment[] }
  | { kind: "replaced"; old: ExistingShift; next: ParsedShift; removeAssignments: ExistingAssignment[] }
  | { kind: "removed"; old: ExistingShift; removeAssignments: ExistingAssignment[] }
  | { kind: "added"; next: ParsedShift }
  | { kind: "takeover"; old: ExistingShift; next: ParsedShift; removeAssignments: ExistingAssignment[] };

export type RemovedAssignmentView = { board: string; stationId: string; hour: number };

export type DatePreview = {
  date: string;
  added: number;
  changed: number;
  /** Changed shifts whose started, assigned hours miss the new window: old kept as history. */
  replaced: number;
  unchanged: number;
  removed: number;
  skippedOpenShifts: number;
  assignmentsKept: number;
  assignmentsToRemove: RemovedAssignmentView[];
  /** Future cells moved to an unambiguous replacement employee. */
  assignmentsToTransfer: RemovedAssignmentView[];
};

export type Refusal =
  | { code: "BOARD_WIPE"; board: string; date: string; message: string }
  | { code: "PERSON_OVERLAP"; date: string; externalId: string; message: string }
  | { code: "TAKEOVER_CONFLICT"; board: string; date: string; message: string };

export type ReconcilePlan = {
  actions: PlanAction[];
  dates: DatePreview[];
  refusals: Refusal[];
  /** True when the file touches a date that already has shifts. */
  touchesImportedDates: boolean;
  /** Stable hash of the shift match and the assignment ids to remove. */
  digest: string;
};

const FLOOR_BOARDS = ["caja", "cocina"] as const;

function ms(d: Date): number {
  return d.getTime();
}

function sameWindow(a: { startAt: Date; endAt: Date }, b: { startAt: Date; endAt: Date }): boolean {
  return ms(a.startAt) === ms(b.startAt) && ms(a.endAt) === ms(b.endAt);
}

function hasStarted(a: ExistingAssignment, now: Date): boolean {
  return ms(now) >= ms(a.hourStart);
}

function stillOnShift(a: ExistingAssignment, next: { startAt: Date; endAt: Date }): boolean {
  return isHourInShift(a.hourStart, next.startAt, next.endAt, a.hourEnd);
}

/**
 * Pair old and new shifts of one (person, position) on one date.
 * Exact time matches first; then greatest overlap, earlier start, existing shift id.
 */
function pairGroup(
  olds: ExistingShift[],
  news: ParsedShift[],
): { pairs: Array<[ExistingShift, ParsedShift]>; oldLeft: ExistingShift[]; newLeft: ParsedShift[] } {
  const candidates: Array<{ o: ExistingShift; n: ParsedShift; ni: number; exact: boolean; overlap: number }> = [];
  news.forEach((n, ni) => {
    for (const o of olds) {
      candidates.push({
        o,
        n,
        ni,
        exact: sameWindow(o, n),
        overlap: shiftOverlapMinutes(o.startAt, o.endAt, n.startAt, n.endAt),
      });
    }
  });
  candidates.sort(
    (a, b) =>
      Number(b.exact) - Number(a.exact) ||
      b.overlap - a.overlap ||
      ms(a.n.startAt) - ms(b.n.startAt) ||
      ms(a.o.startAt) - ms(b.o.startAt) ||
      a.o.id.localeCompare(b.o.id) ||
      a.ni - b.ni,
  );
  const usedOld = new Set<string>();
  const usedNew = new Set<number>();
  const pairs: Array<[ExistingShift, ParsedShift]> = [];
  for (const c of candidates) {
    if (usedOld.has(c.o.id) || usedNew.has(c.ni)) continue;
    usedOld.add(c.o.id);
    usedNew.add(c.ni);
    pairs.push([c.o, c.n]);
  }
  return {
    pairs,
    oldLeft: olds.filter((o) => !usedOld.has(o.id)),
    newLeft: news.filter((_, i) => !usedNew.has(i)),
  };
}

function planPair(old: ExistingShift, next: ParsedShift, now: Date): PlanAction {
  if (sameWindow(old, next)) return { kind: "unchanged", old };
  const started = old.assignments.filter((a) => hasStarted(a, now));
  const future = old.assignments.filter((a) => !hasStarted(a, now));
  if (started.every((a) => stillOnShift(a, next))) {
    return {
      kind: "changed",
      old,
      next,
      removeAssignments: future.filter((a) => !stillOnShift(a, next)),
    };
  }
  return { kind: "replaced", old, next, removeAssignments: future };
}

function groupKey(externalId: string, sourcePosition: string): string {
  return JSON.stringify([externalId, sourcePosition]);
}

function takeoverKey(shift: ExistingShift | ParsedShift): string {
  return JSON.stringify([
    shift.date, shift.board, shift.sourcePosition,
    shift.startAt.toISOString(), shift.endAt.toISOString(),
  ]);
}

/** Match only a single outgoing and incoming shift at the exact same job and time. */
function pairTakeovers(actions: PlanAction[], now: Date): PlanAction[] {
  const removed = new Map<string, Extract<PlanAction, { kind: "removed" }>[]>();
  const added = new Map<string, Extract<PlanAction, { kind: "added" }>[]>();
  for (const action of actions) {
    if (action.kind === "removed") {
      const key = takeoverKey(action.old);
      removed.set(key, [...(removed.get(key) ?? []), action]);
    } else if (action.kind === "added") {
      const key = takeoverKey(action.next);
      added.set(key, [...(added.get(key) ?? []), action]);
    }
  }
  const pairs = new Map<PlanAction, PlanAction>();
  const pairedAdds = new Set<PlanAction>();
  for (const [key, olds] of removed) {
    const news = added.get(key);
    if (olds.length !== 1 || news?.length !== 1) continue;
    const old = olds[0]!;
    const incoming = news[0]!;
    if (old.old.externalId === incoming.next.externalId) continue;
    pairs.set(old, {
      kind: "takeover", old: old.old, next: incoming.next,
      removeAssignments: old.old.assignments.filter((a) => !hasStarted(a, now)),
    });
    pairedAdds.add(incoming);
  }
  return actions.flatMap((action) => pairedAdds.has(action) ? [] : [pairs.get(action) ?? action]);
}

function personOverlaps(shifts: ParsedShift[]): Refusal[] {
  const byPersonDate = new Map<string, ParsedShift[]>();
  for (const s of shifts) {
    const k = JSON.stringify([s.date, s.externalId]);
    byPersonDate.set(k, [...(byPersonDate.get(k) ?? []), s]);
  }
  const out: Refusal[] = [];
  for (const list of byPersonDate.values()) {
    const sorted = [...list].sort((a, b) => ms(a.startAt) - ms(b.startAt));
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1]!;
      const cur = sorted[i]!;
      if (ms(cur.startAt) < ms(prev.endAt)) {
        out.push({
          code: "PERSON_OVERLAP",
          date: cur.date,
          externalId: cur.externalId,
          message: `Employee ID ${cur.externalId} has two shifts that overlap on ${cur.date}. Fix the schedule in When I Work and export again.`,
        });
        break;
      }
    }
  }
  return out;
}

function assignmentView(board: string, a: ExistingAssignment): RemovedAssignmentView {
  return { board, stationId: a.stationId, hour: chicagoHourOf(a.hourStart) };
}

export function planReconcile(opts: {
  fingerprint: string;
  shifts: ParsedShift[];
  /** Open-shift rows skipped by the parser, per date. */
  skippedOpenShifts?: Record<string, number>;
  /** Existing, non-superseded shifts on the file's dates. */
  existing: ExistingShift[];
  now: Date;
}): ReconcilePlan {
  const dates = [
    ...new Set([...opts.shifts.map((s) => s.date), ...Object.keys(opts.skippedOpenShifts ?? {})]),
  ].sort();
  const refusals: Refusal[] = personOverlaps(opts.shifts);
  const actions: PlanAction[] = [];
  const previews: DatePreview[] = [];

  for (const date of dates) {
    const olds = opts.existing.filter((s) => s.date === date);
    const news = opts.shifts.filter((s) => s.date === date);

    for (const board of FLOOR_BOARDS) {
      const had = olds.some((s) => s.board === board);
      const has = news.some((s) => s.board === board);
      if (had && !has) {
        refusals.push({
          code: "BOARD_WIPE",
          board,
          date,
          message: `The file has no ${board} shifts for ${date}, but that board already has a schedule. Nothing was changed. Export the full schedule and upload again.`,
        });
      }
    }

    // File order first (new shifts are created in the order the export lists them).
    const keys = new Set([
      ...news.map((n) => groupKey(n.externalId, n.sourcePosition)),
      ...olds.map((o) => groupKey(o.externalId, o.sourcePosition)),
    ]);
    const dateActions: PlanAction[] = [];
    for (const key of keys) {
      const { pairs, oldLeft, newLeft } = pairGroup(
        olds.filter((o) => groupKey(o.externalId, o.sourcePosition) === key),
        news.filter((n) => groupKey(n.externalId, n.sourcePosition) === key),
      );
      for (const [o, n] of pairs) dateActions.push(planPair(o, n, opts.now));
      for (const o of oldLeft) {
        dateActions.push({
          kind: "removed",
          old: o,
          removeAssignments: o.assignments.filter((a) => !hasStarted(a, opts.now)),
        });
      }
      for (const n of newLeft) dateActions.push({ kind: "added", next: n });
    }

    const resolvedActions = pairTakeovers(dateActions, opts.now);
    const count = (k: PlanAction["kind"]) => resolvedActions.filter((a) => a.kind === k).length;
    const toRemove: RemovedAssignmentView[] = [];
    const toTransfer: RemovedAssignmentView[] = [];
    let kept = 0;
    for (const a of resolvedActions) {
      if (a.kind === "added") continue;
      const removeIds = new Set("removeAssignments" in a ? a.removeAssignments.map((r) => r.id) : []);
      for (const asg of a.old.assignments) {
        if (removeIds.has(asg.id)) {
          (a.kind === "takeover" ? toTransfer : toRemove).push(assignmentView(a.old.board, asg));
        }
        else kept += 1;
      }
    }
    toRemove.sort((x, y) => x.board.localeCompare(y.board) || x.hour - y.hour || x.stationId.localeCompare(y.stationId));
    toTransfer.sort((x, y) => x.board.localeCompare(y.board) || x.hour - y.hour || x.stationId.localeCompare(y.stationId));
    previews.push({
      date,
      added: count("added") + count("takeover"),
      changed: count("changed") + count("replaced"),
      replaced: count("replaced"),
      unchanged: count("unchanged"),
      removed: count("removed") + count("takeover"),
      skippedOpenShifts: opts.skippedOpenShifts?.[date] ?? 0,
      assignmentsKept: kept,
      assignmentsToRemove: toRemove,
      assignmentsToTransfer: toTransfer,
    });
    actions.push(...resolvedActions);
  }

  return {
    actions,
    dates: previews,
    refusals,
    touchesImportedDates: opts.existing.length > 0,
    digest: planDigest(opts.fingerprint, actions),
  };
}

function nextKey(n: ParsedShift) {
  return [n.externalId, n.sourcePosition, n.date, n.startAt.toISOString(), n.endAt.toISOString()];
}

export function planDigest(fingerprint: string, actions: PlanAction[]): string {
  const rows = actions
    .map((a) =>
      JSON.stringify([
        a.kind,
        "old" in a ? a.old.id : null,
        "next" in a ? nextKey(a.next) : null,
        "removeAssignments" in a ? a.removeAssignments.map((r) => r.id).sort() : [],
      ]),
    )
    .sort();
  return createHash("sha256").update(JSON.stringify([fingerprint, rows])).digest("hex");
}
