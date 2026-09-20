import { NextResponse } from "next/server";
import { z } from "zod";
import {
  assignTarea,
  buildTareaSuggestions,
  listTareaAssignments,
  listTareaTemplates,
  setTareaStatus,
} from "@/lib/tareas/service";
import type { FloorBoardId } from "@/lib/board-config";

export const dynamic = "force-dynamic";

function parseBoard(raw: string | null): FloorBoardId | undefined {
  if (raw === "caja" || raw === "cocina") return raw;
  return undefined;
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const date = url.searchParams.get("date");
    const suggest = url.searchParams.get("suggest");
    const hourRaw = url.searchParams.get("hour");
    const forceLemon = url.searchParams.get("forceLemon") === "1";
    const board = parseBoard(url.searchParams.get("board"));

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
      return NextResponse.json({ templates, suggestions });
    }

    if (!date) {
      return NextResponse.json({ templates, assignments: [] });
    }

    const assignments = await listTareaAssignments(date, board);
    return NextResponse.json({ templates, assignments });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: "Failed to load tareas" }, { status: 500 });
  }
}

const postSchema = z.object({
  date: z.string().min(1),
  employeeId: z.string().min(1),
  templateId: z.string().min(1),
  hour: z.number().int(),
  forceLemon: z.boolean().optional(),
  forceSlammed: z.boolean().optional(),
});

export async function POST(req: Request) {
  try {
    const body = postSchema.parse(await req.json());
    const result = await assignTarea(body);
    if (!result.ok) {
      return NextResponse.json(
        {
          error: result.error,
          code: result.code,
          lemonWarning: result.lemonWarning,
          slammedWarning: result.slammedWarning,
        },
        { status: result.status },
      );
    }
    return NextResponse.json({
      assignment: result.assignment,
      lemonWarning: result.lemonWarning,
      slammedWarning: result.slammedWarning,
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
