import { NextResponse } from "next/server";
import { z } from "zod";
import {
  listPerformanceAnswers,
  listPerformanceQuestions,
  upsertPerformanceAnswers,
} from "@/lib/performance/service";
import { isFloorBoardId } from "@/lib/board-config";
import { requireManagerSession } from "@/lib/managers/require-session";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await requireManagerSession(req);
  if (!auth.ok) return auth.response;
  try {
    const url = new URL(req.url);
    const date = url.searchParams.get("date");
    const boardRaw = url.searchParams.get("board");
    const employeeId = url.searchParams.get("employeeId") ?? undefined;
    const questions = await listPerformanceQuestions();

    if (!date || !boardRaw || !isFloorBoardId(boardRaw)) {
      return NextResponse.json({ questions, answers: [] });
    }

    const answers = await listPerformanceAnswers({
      date,
      board: boardRaw,
      employeeId,
    });
    return NextResponse.json({ questions, answers });
  } catch (e) {
    console.error(e);
    return NextResponse.json(
      { error: "Failed to load performance survey" },
      { status: 500 },
    );
  }
}

const postSchema = z.object({
  date: z.string().min(1),
  board: z.enum(["caja", "cocina"]),
  employeeId: z.string().min(1),
  answers: z.array(
    z.object({
      questionId: z.string().min(1),
      value: z.string(),
    }),
  ),
});

export async function POST(req: Request) {
  const auth = await requireManagerSession(req);
  if (!auth.ok) return auth.response;
  try {
    const body = postSchema.parse(await req.json());
    const result = await upsertPerformanceAnswers(body);
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    return NextResponse.json({ answers: result.answers });
  } catch (e) {
    if (e instanceof z.ZodError) {
      return NextResponse.json({ error: e.message }, { status: 422 });
    }
    console.error(e);
    return NextResponse.json(
      { error: "Failed to save performance answers" },
      { status: 500 },
    );
  }
}
