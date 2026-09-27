import type { ParsedShift } from "@/lib/parser/schedule-parser";
import { shiftOverlapMinutes } from "@/lib/rules/shift-window";
import type { ExistingShift, PlanAction, Refusal } from "./reconcile";

export type RemovedOccurrence = {
  id: string;
  shiftId: string | null;
  revision: number;
  externalId: string;
  date: string;
  board: string;
  sourcePosition: string;
  startAt: Date;
  endAt: Date;
};

export type RemovalDecision = {
  overrideId: string;
  action: "unchanged" | "changed" | "relink" | "source-missing";
  next?: ParsedShift;
};

function group(a: { externalId: string; date: string; board: string; sourcePosition: string },
               b: { externalId: string; date: string; board: string; sourcePosition: string }) {
  return a.externalId === b.externalId && a.date === b.date &&
    a.board === b.board && a.sourcePosition === b.sourcePosition;
}

function exact(a: { startAt: Date; endAt: Date }, b: { startAt: Date; endAt: Date }) {
  return a.startAt.getTime() === b.startAt.getTime() && a.endAt.getTime() === b.endAt.getTime();
}

function refusal(override: RemovedOccurrence): Refusal {
  return {
    code: "REMOVAL_IDENTITY",
    date: override.date,
    externalId: override.externalId,
    message: `A removed ${override.board} shift on ${override.date} cannot be matched uniquely to this schedule. Nothing changed. Review the split shifts and resolve the removal before importing.`,
  };
}

/**
 * A local Shift ID can survive the reconciler's zero-overlap greedy match.
 * Only an exact window or a positive-overlap one-to-one source pairing may
 * carry a removed occurrence into a new import.
 */
export function planRemovalIdentity(opts: {
  removals: RemovedOccurrence[];
  existing: ExistingShift[];
  incoming: ParsedShift[];
  actions: PlanAction[];
}): { decisions: RemovalDecision[]; refusals: Refusal[] } {
  const decisions: RemovalDecision[] = [];
  const refusals: Refusal[] = [];
  for (const override of opts.removals) {
    if (override.shiftId === null) {
      const candidates = opts.incoming.filter((s) => group(override, s));
      const exactMatches = candidates.filter((s) => exact(override, s));
      const competingTombstones = opts.removals.filter((other) => other.shiftId === null &&
        group(other, override) && exact(other, override));
      if (candidates.length === 0) {
        decisions.push({ overrideId: override.id, action: "unchanged" });
      } else if (exactMatches.length === 1 && competingTombstones.length === 1 &&
                 opts.actions.some((action) => action.kind === "added" && action.next === exactMatches[0])) {
        decisions.push({ overrideId: override.id, action: "relink", next: exactMatches[0] });
      } else {
        refusals.push(refusal(override));
      }
      continue;
    }

    const action = opts.actions.find((a) => "old" in a && a.old.id === override.shiftId);
    if (!action || action.kind === "added") {
      refusals.push(refusal(override));
    } else if (action.kind === "unchanged") {
      decisions.push({ overrideId: override.id, action: "unchanged" });
    } else if (action.kind === "removed" || action.kind === "takeover") {
      decisions.push({ overrideId: override.id, action: "source-missing" });
    } else {
      const next = action.next;
      const old = action.old;
      const overlap = shiftOverlapMinutes(old.startAt, old.endAt, next.startAt, next.endAt);
      const sourceOlds = opts.existing.filter((s) => group(old, s));
      const sourceNews = opts.incoming.filter((s) => group(next, s));
      const oldCandidates = sourceOlds.filter((s) =>
        shiftOverlapMinutes(s.startAt, s.endAt, next.startAt, next.endAt) > 0);
      const newCandidates = sourceNews.filter((s) =>
        shiftOverlapMinutes(old.startAt, old.endAt, s.startAt, s.endAt) > 0);
      if (overlap <= 0 || oldCandidates.length !== 1 || newCandidates.length !== 1) {
        refusals.push(refusal(override));
      } else {
        decisions.push({ overrideId: override.id,
          action: action.kind === "changed" ? "changed" : "relink", next });
      }
    }
  }
  return { decisions, refusals };
}
