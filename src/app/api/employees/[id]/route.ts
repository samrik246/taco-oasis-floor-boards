import { NextResponse } from "next/server";
import { z } from "zod";
import {
  getEmployee,
  updateEmployee,
} from "@/lib/employees/service";
import { validatePersonWrite, rejectManagerSecrets } from "@/lib/admin/validate";
import { requireManagerSession } from "@/lib/managers/require-session";
import { prisma } from "@/lib/db";

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
  stationId: z.string(),
  level: z.string(),
});

const patchSchema = z.object({
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  email: z.string().nullable().optional(),
  abilities: z.array(abilitySchema).optional(),
});

export async function PATCH(req: Request, context: RouteContext) {
  const auth = await requireManagerSession(req);
  if (!auth.ok) return auth.response;
  try {
    const { id } = await context.params;
    const json = await req.json();
    const secret = rejectManagerSecrets(json);
    if (secret) return NextResponse.json({ error: secret }, { status: 422 });
    const body = patchSchema.parse(json);
    const stations = await prisma.station.findMany({ select: { id: true } });
    const checked = validatePersonWrite(body, {
      creating: false,
      knownStationIds: new Set(stations.map((s) => s.id)),
    });
    if (!checked.ok) {
      return NextResponse.json({ error: checked.error }, { status: 422 });
    }
    const result = await updateEmployee(id, {
      firstName: checked.value.firstName,
      lastName: checked.value.lastName,
      email: checked.value.email,
      abilities: checked.value.abilities,
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
