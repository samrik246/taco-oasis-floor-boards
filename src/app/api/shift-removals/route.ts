import { legacyHttpGuard } from "@/lib/quarter/http";
import { prisma } from "@/lib/db";
import { requireDayAccess } from "@/lib/managers/day-access";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireManagerSession } from "@/lib/managers/require-session";
import { listShiftRemovals, removeShift, resolveMissingRemoval, restoreShift, ShiftRemovalError } from "@/lib/shifts/remove-restore";

export const runtime = "nodejs";

const boardSchema = z.enum(["caja", "cocina"]);
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const sourceSchema = z.object({
  startAt: z.string().datetime(), endAt: z.string().datetime(),
  employeeId: z.string().min(1), sourcePosition: z.string(),
});
const removeSchema = z.object({ action: z.literal("remove"),
  shiftId: z.string().min(1), board: boardSchema, date: dateSchema,
  expected: sourceSchema, expectedRevision: z.number().int().min(0),
  reason: z.string().trim().min(1).max(500),
});
const restoreSchema = z.object({ action: z.literal("restore"),
  id: z.string().min(1), expected: sourceSchema,
  expectedRevision: z.number().int().min(1),
  positions: z.enum(["replay", "none"]), reason: z.string().trim().min(1).max(500),
});
const resolveSchema = z.object({ action: z.literal("resolve"),
  id: z.string().min(1), expectedRevision: z.number().int().min(1),
  reason: z.string().trim().min(1).max(500),
});
const bodySchema = z.discriminatedUnion("action", [removeSchema, restoreSchema, resolveSchema]);

export async function GET(request: Request) {
  const auth = await requireManagerSession(request);
  if (!auth.ok) return auth.response;
  const upgrade = await legacyHttpGuard();
  if (upgrade) return upgrade;
  const url = new URL(request.url);
  const parsed = z.object({ board: boardSchema, date: dateSchema }).safeParse({
    board: url.searchParams.get("board"), date: url.searchParams.get("date"),
  });
  if (!parsed.success) return NextResponse.json({ code: "INVALID_REQUEST" }, { status: 400 });
  const access = await requireDayAccess(request, parsed.data.date);
  if (!access.ok) return access.response;
  const rows = await listShiftRemovals(parsed.data.board, parsed.data.date);
  return NextResponse.json({ removals: rows.map((r) => ({
    id: r.id, shiftId: r.shiftId, externalId: r.externalId,
    date: r.date, board: r.board, sourcePosition: r.sourcePosition,
    startAt: r.startAt.toISOString(), endAt: r.endAt.toISOString(),
    state: r.state, revision: r.revision, savedCells: JSON.parse(r.cellsJson).length,
    currentSource: r.shift && !r.shift.supersededAt ? {
      startAt: r.shift.startAt.toISOString(), endAt: r.shift.endAt.toISOString(),
      employeeId: r.shift.employeeId, sourcePosition: r.shift.sourcePosition,
    } : null,
    events: r.events.map((e) => ({ action: e.action, revision: e.revision,
      managerId: e.managerId, managerName: e.managerName, reason: e.reason,
      source: JSON.parse(e.sourceJson), cells: JSON.parse(e.cellsJson),
      createdAt: e.createdAt.toISOString() })),
  })) }, { headers: { "Cache-Control": "private, no-store" } });
}

export async function POST(request: Request) {
  const auth = await requireManagerSession(request);
  if (!auth.ok) return auth.response;
  const upgrade = await legacyHttpGuard();
  if (upgrade) return upgrade;
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ code: "INVALID_REQUEST", error: "Invalid removal request" }, { status: 400 });
  try {
    const input = parsed.data;
    const date = input.action === "remove" ? input.date : (await prisma.shiftRemoval.findUnique({ where: { id: input.id }, select: { date: true } }))?.date;
    if (date) {
      const access = await requireDayAccess(request, date);
      if (!access.ok) return access.response;
    }
    const result = input.action === "remove"
      ? await removeShift({ ...input, manager: auth.manager })
      : input.action === "restore"
        ? await restoreShift({ ...input, manager: auth.manager })
        : await resolveMissingRemoval({ ...input, manager: auth.manager });
    return NextResponse.json(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof ShiftRemovalError) {
      return NextResponse.json({ code: error.code, error: error.message }, { status: error.status });
    }
    if (error && typeof error === "object" && "code" in error && error.code === "P2002") {
      return NextResponse.json({ code: "POSITION_CONFLICT", error: "A position changed. Refresh before restoring." }, { status: 409 });
    }
    console.error("POST /api/shift-removals", error);
    return NextResponse.json({ code: "REMOVAL_ERROR", error: "Could not change shift visibility" }, { status: 500 });
  }
}
