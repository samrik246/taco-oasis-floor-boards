import { NextResponse } from "next/server";
import { z } from "zod";
import {
  getPerformanceAnswer,
  listPerformanceAnswers,
  listPerformanceQuestions,
  upsertPerformanceAnswer,
} from "@/lib/performance/service";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const date = url.searchParams.get("date");
    const boardRaw = url.searchParams.get("board");
    const employeeId = url.searchParams.get("employeeId");
    const questions = await listPerformanceQuestions();

    if (!date || (boardRaw !== "caja" && boardRaw !== "cocina")) {
      return NextResponse.json({ questions, answers: [] });
    }

    if (employeeId) {
      const record = await getPerformanceAnswer({
        date,
        board: boardRaw,
        employeeId,
      });
      return NextResponse.json({
        questions,
        answer: record
          ? {
              ...record,
              answers: JSON.parse(record.answersJson) as Record<string, string>,
            }
          : null,
      });
    }

    const rows = await listPerformanceAnswers({ date, board: boardRaw });
    return NextResponse.json({
      questions,
      answers: rows.map((r) => ({
        ...r,
        answers: JSON.parse(r.answersJson) as Record<string, string>,
      })),
    });
  } catch (e) {
    console.error(e);
    return NextResponse.json(
      { error: "Failed to load performance answers" },
      { status: 500 },
    );
  }
}

const postSchema = z.object({
  date: z.string().min(1),
  board: z.enum(["caja", "cocina"]),
  employeeId: z.string().min(1),
  answers: z.record(z.string(), z.string()),
});

export async function POST(req: Request) {
  try {
    const body = postSchema.parse(await req.json());
    const result = await upsertPerformanceAnswer(body);
    if (!result.ok) {
      return NextResponse.json(
        { error: result.error },
        { status: result.status },
      );
    }
    const record = result.record!;
    return NextResponse.json({
      answer: {
        ...record,
        answers: JSON.parse(record.answersJson) as Record<string, string>,
      },
    });
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
