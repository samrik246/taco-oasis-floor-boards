import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { hashManagerCode } from "@/lib/managers/codes";
import { requireManagerSession } from "@/lib/managers/require-session";

export const dynamic = "force-dynamic";

/** Names and active flag only. Never returns codeHash or plaintext codes. */
export async function GET(req: Request) {
  const auth = await requireManagerSession(req);
  if (!auth.ok) return auth.response;
  const managers = await prisma.manager.findMany({
    orderBy: { name: "asc" },
    select: { id: true, name: true, active: true },
  });
  return NextResponse.json({ managers });
}

const createSchema = z.object({
  name: z.string().trim().min(1).max(80),
  code: z.string().min(4).max(64),
});

/** Create a manager without returning their code or hash. */
export async function POST(req: Request) {
  const auth = await requireManagerSession(req);
  if (!auth.ok) return auth.response;
  try {
    const input = createSchema.parse(await req.json());
    const existing = await prisma.manager.findFirst({
      where: { name: input.name },
      select: { id: true },
    });
    if (existing) {
      return NextResponse.json(
        { error: "A manager with that name already exists" },
        { status: 409 },
      );
    }
    const manager = await prisma.manager.create({
      data: { name: input.name, codeHash: hashManagerCode(input.code) },
      select: { id: true, name: true, active: true },
    });
    return NextResponse.json({ manager }, { status: 201 });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: "Invalid manager" }, { status: 422 });
    }
    const message = err instanceof Error ? err.message : "Could not create manager";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
