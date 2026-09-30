import { NextResponse } from "next/server";
import { z } from "zod";
import { clearManagedBreak, loadManagedBreak, replaceAutoCover, saveManagedBreak } from "@/lib/breaks/manage";
import { MANAGER_BREAK_TEXT } from "@/lib/breaks/messages";
import { BreakRefused } from "@/lib/breaks/rules";
import { NO_STORE } from "@/lib/managers/day-access";
import { requireGerenteSession } from "@/lib/breaks/authority";
import { breaksNow } from "@/lib/breaks/now";
import { chicagoToday } from "@/lib/upcoming/source";

export const runtime = "nodejs";

const boardSchema = z.enum(["caja", "cocina"]);

const postSchema = z.object({
  board: boardSchema,
  employeeId: z.string().min(1),
  startAt: z.string().min(1).optional(),
  endAt: z.string().min(1).optional(),
  coverEmployeeId: z.string().min(1).optional(),
  shuffleEmployeeId: z.string().min(1).optional(),
  replaceAuto: z.literal(true).optional(),
});

const deleteSchema = z.object({
  board: boardSchema,
  employeeId: z.string().min(1),
});

function refused(error: unknown) {
  if (error instanceof BreakRefused) {
    const line = MANAGER_BREAK_TEXT[error.code] ?? MANAGER_BREAK_TEXT.LOCK_CONFLICT;
    return NextResponse.json({ error: line }, { status: 400, headers: NO_STORE });
  }
  throw error;
}

async function managerOrRefuse(request: Request) {
  const auth = await requireGerenteSession(request, breaksNow());
  if (!auth.ok) return auth;
  return { ok: true as const, role: auth.manager.role, manager: { id: auth.manager.id, name: auth.manager.name, kind: "manager" as const } };
}

export async function GET(request: Request) {
  const auth = await managerOrRefuse(request);
  if (!auth.ok) return auth.response;
  const url = new URL(request.url);
  const board = boardSchema.safeParse(url.searchParams.get("board"));
  const employeeId = url.searchParams.get("employeeId")?.trim() ?? "";
  if (!board.success || !employeeId) {
    return NextResponse.json({ error: "Esa área no tiene descansos." }, { status: 400, headers: NO_STORE });
  }
  try {
    const date = url.searchParams.get("date") ?? chicagoToday(breaksNow());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || (auth.role !== "owner" && date !== chicagoToday(breaksNow()))) {
      return NextResponse.json({ error: "Today only" }, { status: 403, headers: NO_STORE });
    }
    const body = await loadManagedBreak({ board: board.data, employeeId, date });
    return NextResponse.json(body, { headers: NO_STORE });
  } catch (error) {
    return refused(error);
  }
}

export async function POST(request: Request) {
  const auth = await managerOrRefuse(request);
  if (!auth.ok) return auth.response;
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: MANAGER_BREAK_TEXT.ALIGNMENT }, { status: 400, headers: NO_STORE });
  }
  const parsed = postSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: MANAGER_BREAK_TEXT.ALIGNMENT }, { status: 400, headers: NO_STORE });
  }
  if (parsed.data.replaceAuto) {
    if (!parsed.data.coverEmployeeId) {
      return NextResponse.json({ error: MANAGER_BREAK_TEXT.BAD_COVER }, { status: 400, headers: NO_STORE });
    }
    try {
      const saved = await replaceAutoCover({
        manager: auth.manager,
        board: parsed.data.board,
        employeeId: parsed.data.employeeId,
        coverEmployeeId: parsed.data.coverEmployeeId,
        shuffleEmployeeId: parsed.data.shuffleEmployeeId,
      });
      return NextResponse.json({
        id: saved.id,
        replaced: saved.replaced,
        waiting: false,
      }, { headers: NO_STORE });
    } catch (error) {
      return refused(error);
    }
  }
  const startAt = new Date(parsed.data.startAt ?? "");
  const endAt = new Date(parsed.data.endAt ?? "");
  if (Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime())) {
    return NextResponse.json({ error: MANAGER_BREAK_TEXT.ALIGNMENT }, { status: 400, headers: NO_STORE });
  }
  try {
    const saved = await saveManagedBreak({
      manager: auth.manager,
      board: parsed.data.board,
      employeeId: parsed.data.employeeId,
      startAt,
      endAt,
      coverEmployeeId: parsed.data.coverEmployeeId,
      shuffleEmployeeId: parsed.data.shuffleEmployeeId,
    });
    return NextResponse.json({
      id: saved.id,
      replaced: saved.replaced,
      startAt: startAt.toISOString(),
      endAt: endAt.toISOString(),
      waiting: saved.status === "pending",
      ...(saved.status === "pending"
        ? { message: MANAGER_BREAK_TEXT.NEEDS_COVER, covers: saved.covers }
        : {}),
    }, { headers: NO_STORE });
  } catch (error) {
    return refused(error);
  }
}

export async function DELETE(request: Request) {
  const auth = await managerOrRefuse(request);
  if (!auth.ok) return auth.response;
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "Esa área no tiene descansos." }, { status: 400, headers: NO_STORE });
  }
  const parsed = deleteSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "Esa área no tiene descansos." }, { status: 400, headers: NO_STORE });
  }
  try {
    const result = await clearManagedBreak({
      manager: auth.manager,
      board: parsed.data.board,
      employeeId: parsed.data.employeeId,
    });
    return NextResponse.json({ cleared: result.cleared }, { headers: NO_STORE });
  } catch (error) {
    return refused(error);
  }
}
