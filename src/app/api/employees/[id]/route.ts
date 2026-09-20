import { NextResponse } from "next/server";
import { z } from "zod";
import {
  getEmployee,
  isAbilityLevel,
  updateEmployee,
} from "@/lib/employees/service";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_req: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const employee = await getEmployee(id);
    if (!employee) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json({ employee });
  } catch (e) {
    console.error(e);
    return NextResponse.json(
      { error: "Failed to load employee" },
      { status: 500 },
    );
  }
}

const abilitySchema = z.object({
  stationId: z.string().min(1),
  level: z.string().refine(isAbilityLevel, "invalid level"),
});

const patchSchema = z.object({
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  email: z.string().nullable().optional(),
  abilities: z.array(abilitySchema).optional(),
});

export async function PATCH(req: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const body = patchSchema.parse(await req.json());
    const result = await updateEmployee(id, {
      firstName: body.firstName,
      lastName: body.lastName,
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
      { error: "Failed to update employee" },
      { status: 500 },
    );
  }
}
