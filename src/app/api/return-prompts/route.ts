import { NextResponse } from "next/server";
import { z } from "zod";
import {
  acknowledgeReturnPrompt,
  listOpenReturnPrompts,
} from "@/lib/tareas/return-service";
import { boardDateSchema, NO_STORE, requireDayAccess } from "@/lib/managers/day-access";

import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const date = new URL(req.url).searchParams.get("date");
    if (!date) {
      return NextResponse.json({ error: "date required" }, { status: 422 });
    }
    boardDateSchema.parse(date);
    const access = await requireDayAccess(req, date);
    if (!access.ok) return access.response;
    const prompts = await listOpenReturnPrompts(date);
    return NextResponse.json({ prompts }, { headers: NO_STORE });
  } catch (e) {
    if (e instanceof z.ZodError) return NextResponse.json({ error: "Invalid date" }, { status: 422 });
    console.error(e);
    return NextResponse.json(
      { error: "Failed to load return prompts" },
      { status: 500 },
    );
  }
}

const patchSchema = z.object({
  id: z.string().min(1),
});

export async function PATCH(req: Request) {
  try {
    const body = patchSchema.parse(await req.json());
    const stored = await prisma.returnPrompt.findUnique({ where: { id: body.id }, select: { date: true } });
    if (!stored) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const access = await requireDayAccess(req, stored.date);
    if (!access.ok) return access.response;
    const prompt = await acknowledgeReturnPrompt(body.id);
    return NextResponse.json({ prompt });
  } catch (e) {
    if (e instanceof z.ZodError) {
      return NextResponse.json({ error: e.message }, { status: 422 });
    }
    console.error(e);
    return NextResponse.json(
      { error: "Failed to acknowledge prompt" },
      { status: 500 },
    );
  }
}
