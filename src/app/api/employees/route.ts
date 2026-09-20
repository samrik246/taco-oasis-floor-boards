import { NextResponse } from "next/server";
import { z } from "zod";
import {
  createEmployee,
  listEmployees,
  isAbilityLevel,
} from "@/lib/employees/service";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const employees = await listEmployees();
    return NextResponse.json({ employees });
  } catch (e) {
    console.error(e);
    return NextResponse.json(
      { error: "Failed to list employees" },
      { status: 500 },
    );
  }
}

const abilitySchema = z.object({
  stationId: z.string().min(1),
  level: z.string().refine(isAbilityLevel, "invalid level"),
});

const postSchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  externalId: z.string().optional(),
  email: z.string().nullable().optional(),
  abilities: z.array(abilitySchema).optional(),
});

export async function POST(req: Request) {
  try {
    const body = postSchema.parse(await req.json());
    const result = await createEmployee({
      firstName: body.firstName,
      lastName: body.lastName,
      externalId: body.externalId,
      email: body.email,
      abilities: body.abilities?.map((a) => ({
        stationId: a.stationId,
        level: a.level,
      })),
    });
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    return NextResponse.json({ employee: result.employee });
  } catch (e) {
    if (e instanceof z.ZodError) {
      return NextResponse.json({ error: e.message }, { status: 422 });
    }
    console.error(e);
    return NextResponse.json(
      { error: "Failed to create employee" },
      { status: 500 },
    );
  }
}
