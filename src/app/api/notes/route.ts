import { NextResponse } from "next/server";
import { z } from "zod";
import { createNote, listNotes } from "@/lib/notes";
import { requireManagerSession } from "@/lib/managers/require-session";

export const runtime = "nodejs";

const querySchema = z.object({
  board: z.enum(["caja", "cocina"]),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

const createSchema = z.object({
  board: z.enum(["caja", "cocina"]),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  body: z.string().min(1).max(4000),
});

/** GET /api/notes?board=caja&date=YYYY-MM-DD */
export async function GET(request: Request) {
  const auth = await requireManagerSession(request);
  if (!auth.ok) return auth.response;
  try {
    const url = new URL(request.url);
    const { board, date } = querySchema.parse({
      board: url.searchParams.get("board"),
      date: url.searchParams.get("date"),
    });
    const notes = await listNotes(board, date);
    return NextResponse.json({ notes });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json(
        { error: "Invalid board or date", details: err.issues },
        { status: 400 },
      );
    }
    const message = err instanceof Error ? err.message : "Bad request";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

/** POST /api/notes — { board, date, body } */
export async function POST(request: Request) {
  const auth = await requireManagerSession(request);
  if (!auth.ok) return auth.response;
  try {
    const json = await request.json();
    const input = createSchema.parse(json);
    const note = await createNote(input);
    return NextResponse.json({ note }, { status: 201 });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json(
        { error: "Invalid note payload", details: err.issues },
        { status: 400 },
      );
    }
    const message = err instanceof Error ? err.message : "Bad request";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
