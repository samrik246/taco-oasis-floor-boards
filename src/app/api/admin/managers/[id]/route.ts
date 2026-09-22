import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { hashManagerCode } from "@/lib/managers/codes";
import { requireManagerSession } from "@/lib/managers/require-session";

const paramsSchema = z.object({ id: z.string().min(1) });
const updateSchema = z
  .object({
    code: z.string().min(4).max(64).optional(),
    active: z.boolean().optional(),
  })
  .refine((input) => input.code != null || input.active != null, {
    message: "Supply a code or active state",
  });

type RouteContext = { params: Promise<{ id: string }> };

/** Rotate a code or deactivate a manager without exposing stored hashes. */
export async function PATCH(req: Request, context: RouteContext) {
  const auth = await requireManagerSession(req);
  if (!auth.ok) return auth.response;
  try {
    const { id } = paramsSchema.parse(await context.params);
    const input = updateSchema.parse(await req.json());
    const manager = await prisma.manager.findUnique({
      where: { id },
      select: { id: true, active: true },
    });
    if (!manager) {
      return NextResponse.json({ error: "Manager not found" }, { status: 404 });
    }
    if (manager.active && input.active === false) {
      const activeCount = await prisma.manager.count({ where: { active: true } });
      if (activeCount <= 1) {
        return NextResponse.json(
          { error: "At least one manager must stay active" },
          { status: 422 },
        );
      }
    }
    const updated = await prisma.manager.update({
      where: { id },
      data: {
        ...(input.code != null ? { codeHash: hashManagerCode(input.code) } : {}),
        ...(input.active != null ? { active: input.active } : {}),
      },
      select: { id: true, name: true, active: true },
    });
    return NextResponse.json({ manager: updated });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: "Invalid manager update" }, { status: 422 });
    }
    const message = err instanceof Error ? err.message : "Could not update manager";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
