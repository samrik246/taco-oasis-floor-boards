import { prisma } from "@/lib/db";
import { BOARD_CHANGE_ROUTES, writeBoardChange } from "@/lib/board-change-log";
import { clearPasscodeAttempt, reservePasscodeAttempt } from "@/lib/breaks/attempts";
import {
  BREAK_COLLISION,
  BREAK_LOG_ACTOR,
  BREAK_PAUSE,
  BREAK_UNCONFIGURED,
  BREAK_WRONG_CODE,
} from "@/lib/breaks/messages";
import * as passcodes from "@/lib/breaks/passcode";
import { signStaffSession } from "@/lib/breaks/session";
import { managerSessionIsConfigured } from "@/lib/managers/session";
import { chicagoToday } from "@/lib/upcoming/source";

const CODE_PATTERN = /^[0-9]{4}$/;

export type SignInResult =
  | { ok: true; token: string; name: string }
  | { ok: false; status: 401 | 409 | 423 | 503; error: string };

/**
 * Code only. The scan hashes every distinct person on this board today.
 * A pause is decided before any scrypt, and a right code during the pause stays paused.
 */
export async function signInWithCode(
  board: "caja" | "cocina",
  code: string,
  now: Date = new Date(),
): Promise<SignInResult> {
  let pepper: string;
  try {
    pepper = passcodes.staffPasscodePepper();
  } catch (error) {
    if (error instanceof passcodes.PasscodeRefused) {
      return { ok: false, status: 503, error: BREAK_UNCONFIGURED };
    }
    throw error;
  }
  if (!managerSessionIsConfigured()) {
    return { ok: false, status: 503, error: BREAK_UNCONFIGURED };
  }

  const gate = await reservePasscodeAttempt(board, now);
  if (gate === "paused") return { ok: false, status: 423, error: BREAK_PAUSE };

  const trimmed = code.trim();
  if (!CODE_PATTERN.test(trimmed)) {
    return { ok: false, status: 401, error: BREAK_WRONG_CODE };
  }

  const date = chicagoToday(now);
  const shifts = await prisma.shift.findMany({
    where: { board, date, supersededAt: null, boardRemoved: false },
    select: {
      employeeId: true,
      employee: { select: { firstName: true, lastName: true } },
    },
  });
  const people = new Map<string, { firstName: string; lastName: string }>();
  for (const shift of shifts) {
    people.set(shift.employeeId, shift.employee);
  }
  const ids = [...people.keys()];
  const stored = ids.length === 0
    ? []
    : await prisma.staffPasscode.findMany({
      where: { employeeId: { in: ids } },
      select: { employeeId: true, hash: true, salt: true },
    });
  const byId = new Map(stored.map((row) => [row.employeeId, row]));
  const matches: string[] = [];
  for (const employeeId of ids) {
    const row = byId.get(employeeId) ?? null;
    if (await passcodes.passcodeMatches(row, trimmed, pepper)) matches.push(employeeId);
  }

  if (matches.length > 1) {
    await prisma.$transaction(async (tx) => {
      await writeBoardChange(tx, {
        id: BREAK_LOG_ACTOR.id,
        name: BREAK_LOG_ACTOR.name,
        route: BOARD_CHANGE_ROUTES.breakCodeCollision,
      }, { date, count: matches.length, board });
    });
    return { ok: false, status: 409, error: BREAK_COLLISION };
  }
  if (matches.length !== 1) return { ok: false, status: 401, error: BREAK_WRONG_CODE };

  const employeeId = matches[0]!;
  await clearPasscodeAttempt(board, now);
  const person = people.get(employeeId)!;
  return {
    ok: true,
    token: signStaffSession({ employeeId, board }),
    name: `${person.firstName} ${person.lastName}`.trim(),
  };
}
