import { NextResponse } from "next/server";
import { z } from "zod";
import {
  acknowledgeReturnPrompt,
  listOpenReturnPrompts,
} from "@/lib/tareas/return-service";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const date = new URL(req.url).searchParams.get("date");
    if (!date) {
      return NextResponse.json({ error: "date required" }, { status: 422 });
    }
    const prompts = await listOpenReturnPrompts(date);
    return NextResponse.json({ prompts });
  } catch (e) {
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
