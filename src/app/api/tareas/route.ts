import { NextResponse } from "next/server";
import { z } from "zod";
import {
  assignTarea,
  buildTareaSuggestions,
  listTareaAssignments,
  listTareaTemplates,
  setTareaStatus,
} from "@/lib/tareas/service";
import { isFloorBoardId } from "@/lib/board-config";
import { requireManagerSession } from "@/lib/managers/require-session";
import { boardDateSchema, NO_STORE, requireDayAccess } from "@/lib/managers/day-access";

import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const date = url.searchParams.get("date");
    const suggest = url.searchParams.get("suggest");
    const hourRaw = url.searchParams.get("hour");
    const forceLemon = url.searchParams.get("forceLemon") === "1";
    const boardRaw = url.searchParams.get("board");
    const board =
      boardRaw && isFloorBoardId(boardRaw) ? boardRaw : undefined;

    if (date) {
      boardDateSchema.parse(date);
      const access = await requireDayAccess(req, date);
      if (!access.ok) return access.response;
    }

    const templates = await listTareaTemplates(board);

    if (suggest && date && hourRaw != null) {
      const hour = Number(hourRaw);
      const suggestions = await buildTareaSuggestions({
        date,
        hour,
        templateId: suggest,
        forceLemon,
        board,
      });
      return NextResponse.json({ templates, suggestions }, { headers: NO_STORE });
    }

    if (!date) {
      return NextResponse.json({ templates, assignments: [] });
    }

    const assignments = await listTareaAssignments(date, board);
    return NextResponse.json({ templates, assignments }, { headers: NO_STORE });
  } catch (e) {
    if (e instanceof z.ZodError) return NextResponse.json({ error: "Invalid date" }, { status: 422 });
    console.error(e);
    return NextResponse.json({ error: "Failed to load tareas" }, { status: 500 });
  }
}

const postSchema = z.object({
  date: boardDateSchema,
  employeeId: z.string().min(1),
  templateId: z.string().min(1),
  hour: z.number().int(),
  forceLemon: z.boolean().optional(),
});

/** Assigning a tarea plans someone's time: manager session required. */
export async function POST(req: Request) {
  const auth = await requireManagerSession(req);
  if (!auth.ok) return auth.response;
  try {
    const body = postSchema.parse(await req.json());
    const access = await requireDayAccess(req, body.date);
    if (!access.ok) return access.response;
    const result = await assignTarea(body);
    if (!result.ok) {
      return NextResponse.json(
        {
          error: result.error,
          code: result.code,
          lemonWarning: result.lemonWarning,
        },
        { status: result.status },
      );
    }
    return NextResponse.json({
      assignment: result.assignment,
      lemonWarning: result.lemonWarning,
    });
  } catch (e) {
    if (e instanceof z.ZodError) {
      return NextResponse.json({ error: e.message }, { status: 422 });
    }
    console.error(e);
    return NextResponse.json({ error: "Failed to assign tarea" }, { status: 500 });
  }
}

const patchSchema = z.object({
  id: z.string().min(1),
  status: z.enum(["working", "done"]),
});

export async function PATCH(req: Request) {
  try {
    const body = patchSchema.parse(await req.json());
    const stored = await prisma.tareaAssignment.findUnique({ where: { id: body.id }, select: { date: true } });
    if (!stored) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const access = await requireDayAccess(req, stored.date);
    if (!access.ok) return access.response;
    const updated = await setTareaStatus(body);
    if (!updated) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json({ assignment: updated });
  } catch (e) {
    if (e instanceof z.ZodError) {
      return NextResponse.json({ error: e.message }, { status: 422 });
    }
    console.error(e);
    return NextResponse.json({ error: "Failed to update tarea" }, { status: 500 });
  }
}
