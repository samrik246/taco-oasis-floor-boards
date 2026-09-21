import { NextResponse } from "next/server";
import { z } from "zod";
import {
  createEmployee,
  listEmployees,
} from "@/lib/employees/service";
import { validatePersonWrite, rejectManagerSecrets } from "@/lib/admin/validate";
import { requireManagerSession } from "@/lib/managers/require-session";
import { prisma } from "@/lib/db";

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
  stationId: z.string(),
  level: z.string(),
});

const postSchema = z.object({
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  externalId: z.string().optional(),
  email: z.string().nullable().optional(),
  abilities: z.array(abilitySchema).optional(),
});

export async function POST(req: Request) {
  const auth = await requireManagerSession(req);
  if (!auth.ok) return auth.response;
  try {
    const json = await req.json();
    const secret = rejectManagerSecrets(json);
    if (secret) return NextResponse.json({ error: secret }, { status: 422 });
    const body = postSchema.parse(json);
    const stations = await prisma.station.findMany({ select: { id: true } });
    const checked = validatePersonWrite(body, {
      creating: true,
      knownStationIds: new Set(stations.map((s) => s.id)),
    });
    if (!checked.ok) {
      return NextResponse.json({ error: checked.error }, { status: 422 });
    }
    const result = await createEmployee({
      firstName: checked.value.firstName ?? "",
      lastName: checked.value.lastName ?? "",
      externalId: checked.value.externalId,
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
      { error: "Failed to create employee" },
      { status: 500 },
    );
  }
}
