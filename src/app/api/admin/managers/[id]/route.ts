import { NextResponse } from "next/server";
import { z } from "zod";
import {
  deleteManagerAccess,
  updateManagerAccess,
} from "@/lib/managers/admin-mutate";
import { requireOwnerSession } from "@/lib/managers/require-session";

const paramsSchema = z.object({ id: z.string().min(1) });
const updateSchema = z
  .object({
    code: z.string().min(4).max(64).optional(),
    active: z.boolean().optional(),
    role: z.enum(["owner", "manager"]).optional(),
    longIdle: z.boolean().optional(),
  })
  .refine(
    (input) =>
      input.code != null ||
      input.active != null ||
      input.role != null ||
      input.longIdle != null,
    { message: "Supply a code, active state, role, or long-idle flag" },
  );

type RouteContext = { params: Promise<{ id: string }> };

function fromMutate(result: { ok: true; status: 200; manager: unknown } | { ok: false; status: number; error: string }) {
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({ manager: result.manager });
}

/** Rotate a code, change role, or deactivate a manager without exposing stored hashes. */
export async function PATCH(req: Request, context: RouteContext) {
  const auth = await requireOwnerSession(req);
  if (!auth.ok) return auth.response;
  try {
    const { id } = paramsSchema.parse(await context.params);
    const input = updateSchema.parse(await req.json());
    return fromMutate(await updateManagerAccess(id, input));
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: "Invalid manager update" }, { status: 422 });
    }
    const message = err instanceof Error ? err.message : "Could not update manager";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

/** Delete a manager. The last active owner is refused with 409 and left in place. */
export async function DELETE(req: Request, context: RouteContext) {
  const auth = await requireOwnerSession(req);
  if (!auth.ok) return auth.response;
  try {
    const { id } = paramsSchema.parse(await context.params);
    const result = await deleteManagerAccess(id);
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    return NextResponse.json({ deleted: result.manager.id });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: "Invalid manager id" }, { status: 422 });
    }
    const message = err instanceof Error ? err.message : "Could not delete manager";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
