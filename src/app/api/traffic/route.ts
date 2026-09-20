import { NextResponse } from "next/server";
import { z } from "zod";
import {
  getTrafficState,
  setTrafficEnabled,
  tickTrafficIfDue,
} from "@/lib/traffic/service";

export const dynamic = "force-dynamic";

/** GET — current meters; ticks simulator if due (15s) when date+hour provided */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const date = url.searchParams.get("date") ?? undefined;
    const hourRaw = url.searchParams.get("hour");
    const hour = hourRaw != null ? Number(hourRaw) : undefined;

    const state =
      date != null && hour != null && Number.isFinite(hour)
        ? await tickTrafficIfDue({ date, hour })
        : await getTrafficState();

    return NextResponse.json(state);
  } catch (e) {
    console.error(e);
    return NextResponse.json(
      { error: "Failed to load traffic state" },
      { status: 500 },
    );
  }
}

const patchSchema = z.object({
  enabled: z.boolean(),
  date: z.string().optional(),
  hour: z.number().int().optional(),
});

/** PATCH — manager on/off toggle for fake order simulator */
export async function PATCH(req: Request) {
  try {
    const body = patchSchema.parse(await req.json());
    const state = await setTrafficEnabled(body.enabled);
    if (body.enabled && body.date != null && body.hour != null) {
      return NextResponse.json(
        await tickTrafficIfDue({ force: true, date: body.date, hour: body.hour }),
      );
    }
    return NextResponse.json(state);
  } catch (e) {
    if (e instanceof z.ZodError) {
      return NextResponse.json({ error: e.message }, { status: 422 });
    }
    console.error(e);
    return NextResponse.json(
      { error: "Failed to update traffic simulator" },
      { status: 500 },
    );
  }
}
