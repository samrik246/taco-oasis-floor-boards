import { NextResponse } from "next/server";
import { parseScheduleWorkbook } from "@/lib/parser/schedule-parser";
import { persistImport } from "@/lib/import/persist-import";
import { requireManagerSession } from "@/lib/managers/require-session";
import { z } from "zod";

export const runtime = "nodejs";

const metaSchema = z.object({
  filename: z.string().min(1),
});

export async function POST(request: Request) {
  const auth = await requireManagerSession(request);
  if (!auth.ok) return auth.response;
  try {
    const contentType = request.headers.get("content-type") ?? "";
    let buffer: Buffer;
    let filename: string;

    if (contentType.includes("multipart/form-data")) {
      const form = await request.formData();
      const file = form.get("file");
      if (!(file instanceof File)) {
        return NextResponse.json(
          { error: "Expected multipart field 'file'" },
          { status: 400 },
        );
      }
      filename = file.name || "upload.xlsx";
      buffer = Buffer.from(await file.arrayBuffer());
    } else {
      // Raw body with filename query/header fallback
      const url = new URL(request.url);
      filename =
        url.searchParams.get("filename") ||
        request.headers.get("x-filename") ||
        "upload.xlsx";
      metaSchema.parse({ filename });
      buffer = Buffer.from(await request.arrayBuffer());
    }

    if (!buffer.length) {
      return NextResponse.json({ error: "Empty upload" }, { status: 400 });
    }

    const parsed = await parseScheduleWorkbook(buffer, { filename });
    const { importBatchId, rowCount } = await persistImport(parsed, filename);

    return NextResponse.json({
      importBatchId,
      rowCount,
      bucketCounts: parsed.bucketCounts,
      dates: parsed.dates,
      strippedPayColumns: parsed.strippedPayColumns,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Import failed";
    console.error("POST /api/imports", err);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
