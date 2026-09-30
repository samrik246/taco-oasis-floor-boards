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
import { gerenteAuthority } from "@/lib/breaks/authority";
import { managerIdleMsFor, verifyManagerCodeHash } from "@/lib/managers/codes";
import { managerSessionIsConfigured, signManagerSession } from "@/lib/managers/session";
import { chicagoToday } from "@/lib/upcoming/source";

const CODE_PATTERN = /^[0-9]{4}$/;

export type SignInResult =
  | { ok: true; token: string; name: string; kind: "staff" | "gerente" | "manager"; manager?: { id: string; name: string; role: string }; staffToken?: string; idleMs?: number; role?: string }
  | { ok: false; status: 401 | 409 | 423 | 503; error: string };

/**
 * Code only. The scan hashes every distinct person on either floor board today.
 * A pause is decided before any scrypt, and a right code during the pause stays paused.
 */
export async function signInWithCode(
  board: "caja" | "cocina",
  code: string,
  now: Date = new Date(),
  purpose: "break" | "floor" = "break",
): Promise<SignInResult> {
  if (!managerSessionIsConfigured()) {
    return { ok: false, status: 503, error: BREAK_UNCONFIGURED };
  }

  const gate = await reservePasscodeAttempt(board, now);
  if (gate === "paused") return { ok: false, status: 423, error: BREAK_PAUSE };

  const trimmed = code.trim();
  if (trimmed.length < 4 || trimmed.length > 64) {
    return { ok: false, status: 401, error: BREAK_WRONG_CODE };
  }

  const date = chicagoToday(now);
  const shifts = await prisma.shift.findMany({
    where: { board: { in: ["caja", "cocina"] }, date, supersededAt: null, boardRemoved: false },
    select: {
      employeeId: true,
      employee: { select: { firstName: true, lastName: true } },
    },
  });
  const people = new Map<string, { firstName: string; lastName: string }>();
  for (const shift of shifts) {
    people.set(shift.employeeId, shift.employee);
  }
  const ids = CODE_PATTERN.test(trimmed) ? [...people.keys()] : [];
  const stored = ids.length === 0
    ? []
    : await prisma.staffPasscode.findMany({
      where: { employeeId: { in: ids } },
      select: { employeeId: true, hash: true, salt: true },
    });
  let pepper = "";
  try {
    // Long manager credentials need no staff hash. Numeric collisions must still be checked.
    if (purpose === "break" || stored.length > 0) pepper = passcodes.staffPasscodePepper();
  } catch (error) {
    if (error instanceof passcodes.PasscodeRefused) return { ok: false, status: 503, error: BREAK_UNCONFIGURED };
    throw error;
  }
  const byId = new Map(stored.map((row) => [row.employeeId, row]));
  const matches: string[] = [];
  for (const employeeId of ids) {
    const row = byId.get(employeeId) ?? null;
    if (pepper && await passcodes.passcodeMatches(row, trimmed, pepper)) matches.push(employeeId);
  }

  const managers = await prisma.manager.findMany({
    select: { id: true, name: true, codeHash: true, active: true, role: true, longIdle: true, employeeId: true },
  });
  const managerMatches = managers.filter(m => verifyManagerCodeHash(trimmed, m.codeHash));
  const manager = managerMatches[0];
  const collision = matches.length > 1 || managerMatches.length > 1
    || (manager != null && matches.some(id => id !== manager.employeeId));
  if (collision) {
    await prisma.$transaction(async (tx) => {
      await writeBoardChange(tx, {
        id: BREAK_LOG_ACTOR.id,
        name: BREAK_LOG_ACTOR.name,
        route: BOARD_CHANGE_ROUTES.breakCodeCollision,
      }, { date, count: matches.length + managerMatches.length, board });
    });
    return { ok: false, status: 409, error: BREAK_COLLISION };
  }
  if (manager?.active && (purpose === "floor" || await gerenteAuthority(manager.id, now))) {
    await clearPasscodeAttempt(board, now);
    return {
      ok: true, kind: purpose === "floor" ? "manager" : "gerente", name: manager.name,
      manager: { id: manager.id, name: manager.name, role: manager.role },
      token: signManagerSession({ id: manager.id, name: manager.name }),
      idleMs: managerIdleMsFor(manager), role: manager.role,
      ...(manager.employeeId && people.has(manager.employeeId)
        ? { staffToken: signStaffSession({ employeeId: manager.employeeId, board }) } : {}),
    };
  }
  // A paired active code may identify its own worker even when its gerente shift has ended.
  if (matches.length === 0 && manager?.active && manager.employeeId && people.has(manager.employeeId)) matches.push(manager.employeeId);
  if (matches.length !== 1) return { ok: false, status: 401, error: BREAK_WRONG_CODE };

  const employeeId = matches[0]!;
  await clearPasscodeAttempt(board, now);
  const person = people.get(employeeId)!;
  return {
    ok: true,
    kind: "staff",
    token: signStaffSession({ employeeId, board }),
    name: `${person.firstName} ${person.lastName}`.trim(),
  };
}
