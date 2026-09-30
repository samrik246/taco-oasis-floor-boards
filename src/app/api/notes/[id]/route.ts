import { NextResponse } from "next/server";
import { z } from "zod";
import { deleteNote, updateNote } from "@/lib/notes";
import { requireManagerSession } from "@/lib/managers/require-session";

import { prisma } from "@/lib/db";
import { requireDayAccess } from "@/lib/managers/day-access";

export const runtime = "nodejs";

const paramsSchema = z.object({
  id: z.string().min(1),
});

const updateSchema = z.object({
  body: z.string().min(1).max(4000),
});

type RouteContext = { params: Promise<{ id: string }> };

/** PUT /api/notes/:id — { body } */
export async function PUT(request: Request, context: RouteContext) {
  const auth = await requireManagerSession(request);
  if (!auth.ok) return auth.response;
  try {
    const { id } = paramsSchema.parse(await context.params);
    const stored = await prisma.managerNote.findUnique({ where: { id }, select: { date: true } });
    if (!stored) return NextResponse.json({ error: "Note not found" }, { status: 404 });
    const access = await requireDayAccess(request, stored.date);
    if (!access.ok) return access.response;
    const json = await request.json();
    const { body } = updateSchema.parse(json);
    const note = await updateNote(id, body);
    if (!note) {
      return NextResponse.json({ error: "Note not found" }, { status: 404 });
    }
    return NextResponse.json({ note });
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

/** DELETE /api/notes/:id */
export async function DELETE(request: Request, context: RouteContext) {
  const auth = await requireManagerSession(request);
  if (!auth.ok) return auth.response;
  try {
    const { id } = paramsSchema.parse(await context.params);
    const stored = await prisma.managerNote.findUnique({ where: { id }, select: { date: true } });
    if (!stored) return NextResponse.json({ error: "Note not found" }, { status: 404 });
    const access = await requireDayAccess(request, stored.date);
    if (!access.ok) return access.response;
    const ok = await deleteNote(id);
    if (!ok) {
      return NextResponse.json({ error: "Note not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true, id });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json(
        { error: "Invalid id", details: err.issues },
        { status: 400 },
      );
    }
    const message = err instanceof Error ? err.message : "Bad request";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
