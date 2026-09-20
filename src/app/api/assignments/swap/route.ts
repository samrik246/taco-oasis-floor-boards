import { NextResponse } from "next/server";
import { z } from "zod";
import { swapAssignments } from "@/lib/assignments/service";

export const runtime = "nodejs";

const bodySchema = z.object({
  assignmentIdA: z.string().min(1),
  assignmentIdB: z.string().min(1),
});

/**
 * POST /api/assignments/swap — swap people on two assignments with re-validation.
 */
export async function POST(request: Request) {
  try {
    const json = await request.json();
    const body = bodySchema.parse(json);
    const result = await swapAssignments(
      body.assignmentIdA,
      body.assignmentIdB,
    );

    if (!result.ok) {
      return NextResponse.json(
        { error: "Swap rejected", violations: result.violations },
        { status: result.status },
      );
    }

    return NextResponse.json({ assignments: result.assignments });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json(
        { error: "Invalid body", details: err.issues },
        { status: 400 },
      );
    }
    const message = err instanceof Error ? err.message : "Swap failed";
    console.error("POST /api/assignments/swap", err);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
