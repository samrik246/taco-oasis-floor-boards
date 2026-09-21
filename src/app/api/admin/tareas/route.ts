import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { validateTareaWrite, rejectManagerSecrets } from "@/lib/admin/validate";
import { requireManagerSession } from "@/lib/managers/require-session";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await requireManagerSession(req);
  if (!auth.ok) return auth.response;
  const templates = await prisma.tareaTemplate.findMany({
    orderBy: [{ board: "asc" }, { sortOrder: "asc" }],
  });
  return NextResponse.json({
    templates: templates.map((template) => ({
      id: template.id,
      code: template.code,
      label: template.label,
      mode: template.mode,
      sortOrder: template.sortOrder,
      board: template.board,
      lemonWarnOnGreens: template.lemonWarnOnGreens,
    })),
  });
}

const patchSchema = z.object({
  id: z.string().min(1),
  label: z.string(),
  mode: z.string().optional(),
  board: z.string().optional(),
  sortOrder: z.number().optional(),
});

export async function PATCH(req: Request) {
  const auth = await requireManagerSession(req);
  if (!auth.ok) return auth.response;
  try {
    const json = await req.json();
    const secret = rejectManagerSecrets(json);
    if (secret) return NextResponse.json({ error: secret }, { status: 422 });
    const body = patchSchema.parse(json);
    const checked = validateTareaWrite(body);
    if (!checked.ok) {
      return NextResponse.json({ error: checked.error }, { status: 422 });
    }
    const existing = await prisma.tareaTemplate.findUnique({
      where: { id: body.id },
    });
    if (!existing) {
      return NextResponse.json({ error: "Tarea not found." }, { status: 404 });
    }
    const template = await prisma.tareaTemplate.update({
      where: { id: body.id },
      data: checked.value,
    });
    return NextResponse.json({
      template: {
        id: template.id,
        code: template.code,
        label: template.label,
        mode: template.mode,
        board: template.board,
        sortOrder: template.sortOrder,
      },
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: "Invalid tarea" }, { status: 422 });
    }
    console.error(err);
    return NextResponse.json({ error: "Failed to update tarea" }, { status: 500 });
  }
}
