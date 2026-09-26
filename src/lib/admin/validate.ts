import { hourGridHours } from "@/lib/hour-grid";
import type { RuleViolation } from "@/lib/rules/types";

export const STATION_COLORS = [
  "pink",
  "green",
  "yellow",
  "purple",
  "lime",
  "blue",
  "lavender",
  "gray",
  "teal",
  "orange",
  "cyan",
  "red",
  "brown",
  "maroon",
] as const;

export type StationColor = (typeof STATION_COLORS)[number];

const STATION_ID_RE = /^[a-z][a-z0-9_]{0,31}$/;
const SHORT_CODE_RE = /^[A-Za-z0-9]{1,8}$/;
const ABILITY_LEVELS = ["forbidden", "training", "ok", "preferred"] as const;

export type FieldError = { ok: false; error: string };
export type FieldOk<T> = { ok: true; value: T };

export type StationDraft = {
  id: string;
  label: string;
  color: StationColor;
  shortCode: string;
  board: "caja" | "cocina";
  sortOrder: number;
};

export function validateStationWrite(
  input: {
    id?: string;
    label?: string;
    color?: string;
    shortCode?: string;
    board?: string;
    sortOrder?: number;
  },
  opts: {
    id: string;
    creating: boolean;
    others: { id: string; shortCode: string }[];
  },
): FieldOk<StationDraft> | FieldError {
  const id = (opts.creating ? input.id : opts.id)?.trim() ?? "";
  if (!id) return { ok: false, error: "Station id is required." };
  if (!STATION_ID_RE.test(id)) {
    return {
      ok: false,
      error:
        "Station id must be lowercase letters, numbers, or underscores, and start with a letter.",
    };
  }
  if (opts.creating && opts.others.some((row) => row.id === id)) {
    return { ok: false, error: `Station id "${id}" already exists.` };
  }

  const label = input.label?.trim() ?? "";
  if (!label) return { ok: false, error: "Label is required." };
  if (label.length > 80) return { ok: false, error: "Label must be 80 characters or fewer." };

  const color = input.color?.trim() ?? "";
  if (!STATION_COLORS.includes(color as StationColor)) {
    return {
      ok: false,
      error: `Color must be one of: ${STATION_COLORS.join(", ")}.`,
    };
  }

  const shortCode = input.shortCode?.trim() ?? "";
  if (!shortCode) return { ok: false, error: "Short code is required." };
  if (!SHORT_CODE_RE.test(shortCode)) {
    return {
      ok: false,
      error: "Short code must be 1–8 letters or numbers.",
    };
  }
  const codeKey = shortCode.toUpperCase();
  const clash = opts.others.find(
    (row) => row.id !== id && row.shortCode.toUpperCase() === codeKey,
  );
  if (clash) {
    return {
      ok: false,
      error: `Short code ${codeKey} is already used by station ${clash.id}.`,
    };
  }

  if (input.board !== "caja" && input.board !== "cocina") {
    return { ok: false, error: "Board must be caja or cocina." };
  }

  const sortOrder = input.sortOrder ?? 0;
  if (!Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > 99) {
    return { ok: false, error: "Sort order must be a whole number from 0 to 99." };
  }

  return {
    ok: true,
    value: {
      id,
      label,
      color: color as StationColor,
      shortCode: codeKey,
      board: input.board,
      sortOrder,
    },
  };
}

export function validatePersonWrite(
  input: {
    firstName?: string;
    lastName?: string;
    email?: string | null;
    externalId?: string;
    abilities?: { stationId: string; level: string }[];
  },
  opts: { creating: boolean; knownStationIds: Set<string> },
): FieldOk<{
  firstName?: string;
  lastName?: string;
  email?: string | null;
  externalId?: string;
  abilities?: { stationId: string; level: "forbidden" | "training" | "ok" | "preferred" }[];
}> | FieldError {
  const firstName = input.firstName?.trim();
  const lastName = input.lastName?.trim();
  if (opts.creating && !firstName) return { ok: false, error: "First name is required." };
  if (opts.creating && !lastName) return { ok: false, error: "Last name is required." };
  if (input.firstName != null && !firstName) {
    return { ok: false, error: "First name is required." };
  }
  if (input.lastName != null && !lastName) {
    return { ok: false, error: "Last name is required." };
  }
  if (firstName && firstName.length > 60) {
    return { ok: false, error: "First name must be 60 characters or fewer." };
  }
  if (lastName && lastName.length > 60) {
    return { ok: false, error: "Last name must be 60 characters or fewer." };
  }

  let email: string | null | undefined;
  if (input.email !== undefined) {
    const trimmed = input.email?.trim() ?? "";
    if (trimmed && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      return { ok: false, error: "Email is not valid." };
    }
    email = trimmed || null;
  }

  let abilities:
    | { stationId: string; level: "forbidden" | "training" | "ok" | "preferred" }[]
    | undefined;
  if (input.abilities) {
    const seen = new Set<string>();
    abilities = [];
    for (const ability of input.abilities) {
      const stationId = ability.stationId?.trim();
      if (!stationId) return { ok: false, error: "Each ability needs a station." };
      if (seen.has(stationId)) {
        return { ok: false, error: `Ability for ${stationId} is listed twice.` };
      }
      seen.add(stationId);
      if (!opts.knownStationIds.has(stationId)) {
        return { ok: false, error: `Unknown station: ${stationId}.` };
      }
      if (!ABILITY_LEVELS.includes(ability.level as (typeof ABILITY_LEVELS)[number])) {
        return {
          ok: false,
          error: `Ability for ${stationId} must be forbidden, training, ok, or preferred.`,
        };
      }
      abilities.push({
        stationId,
        level: ability.level as "forbidden" | "training" | "ok" | "preferred",
      });
    }
  }

  return {
    ok: true,
    value: {
      ...(firstName ? { firstName } : {}),
      ...(lastName ? { lastName } : {}),
      ...(email !== undefined ? { email } : {}),
      ...(input.externalId != null ? { externalId: input.externalId.trim() } : {}),
      ...(abilities ? { abilities } : {}),
    },
  };
}

export function validateTareaWrite(input: {
  label?: string;
  mode?: string;
  board?: string;
  sortOrder?: number;
}): FieldOk<{
  label: string;
  mode?: "normal" | "backlog_when_slow";
  board?: "caja" | "cocina";
  sortOrder?: number;
}> | FieldError {
  const label = input.label?.trim() ?? "";
  if (!label) return { ok: false, error: "Tarea label is required." };
  if (label.length > 120) {
    return { ok: false, error: "Tarea label must be 120 characters or fewer." };
  }
  let mode: "normal" | "backlog_when_slow" | undefined;
  if (input.mode != null) {
    if (input.mode !== "normal" && input.mode !== "backlog_when_slow") {
      return { ok: false, error: "Tarea mode must be normal or backlog_when_slow." };
    }
    mode = input.mode;
  }
  let board: "caja" | "cocina" | undefined;
  if (input.board != null) {
    if (input.board !== "caja" && input.board !== "cocina") {
      return { ok: false, error: "Tarea board must be caja or cocina." };
    }
    board = input.board;
  }
  if (
    input.sortOrder != null &&
    (!Number.isInteger(input.sortOrder) || input.sortOrder < 0 || input.sortOrder > 99)
  ) {
    return { ok: false, error: "Sort order must be a whole number from 0 to 99." };
  }
  return {
    ok: true,
    value: {
      label,
      ...(mode ? { mode } : {}),
      ...(board ? { board } : {}),
      ...(input.sortOrder != null ? { sortOrder: input.sortOrder } : {}),
    },
  };
}

/** Percents are a share of that day’s sales. They must add up to about 100. */
export function validateSalesPercents(
  rows: { hour: number; percent: number }[],
): FieldOk<{ hour: number; percent: number }[]> | FieldError {
  const hours = hourGridHours();
  const seen = new Set<number>();
  for (const row of rows) {
    if (!hours.includes(row.hour)) {
      return { ok: false, error: `Hour ${row.hour} is outside 7a–9p.` };
    }
    if (seen.has(row.hour)) {
      return { ok: false, error: `Hour ${row.hour} is listed twice.` };
    }
    seen.add(row.hour);
    if (!Number.isFinite(row.percent) || row.percent < 0) {
      return { ok: false, error: `Hour ${row.hour} percent must be zero or more.` };
    }
    if (row.percent > 100) {
      return { ok: false, error: `Hour ${row.hour} percent cannot be over 100.` };
    }
  }
  for (const hour of hours) {
    if (!seen.has(hour)) {
      return { ok: false, error: `Missing percent for ${hour}:00.` };
    }
  }
  const sum = rows.reduce((total, row) => total + row.percent, 0);
  if (sum < 99 || sum > 101) {
    return {
      ok: false,
      error: `Sales percents must add up to about 100% of the day (got ${sum.toFixed(1)}%).`,
    };
  }
  const factor = 100 / sum;
  return {
    ok: true,
    value: hours.map((hour) => ({
      hour,
      percent: rows.find((row) => row.hour === hour)!.percent * factor,
    })),
  };
}

const SECRET_KEYS = ["code", "codeHash", "password", "pin", "accessCode", "plaintext"];

/** Back office must never accept or echo a manager access code. */
export function rejectManagerSecrets(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const keys = Object.keys(body as Record<string, unknown>);
  const hit = keys.find((key) => SECRET_KEYS.includes(key));
  if (!hit) return null;
  return "Manager codes are not editable and are never shown.";
}

export function seatRejection(violations: RuleViolation[]): string {
  if (violations.some((v) => v.code === "STATION_FULL")) {
    return "That station already has someone this hour. One person per station.";
  }
  if (violations.some((v) => v.code === "PERSON_ALREADY_ASSIGNED")) {
    return "That person is already on a station this hour. One person per station.";
  }
  if (violations.length === 0) return "Seat rejected.";
  return violations.map((v) => v.message).join(" ");
}
