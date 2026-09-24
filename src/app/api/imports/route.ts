import { NextResponse } from "next/server";
import { parseScheduleWorkbook } from "@/lib/parser/schedule-parser";
import {
  commitImport,
  ImportRefusedError,
  previewImport,
} from "@/lib/import/persist-import";
import { requireManagerSession } from "@/lib/managers/require-session";
import { z } from "zod";

export const runtime = "nodejs";

const metaSchema = z.object({
  filename: z.string().min(1),
  mode: z.enum(["preview", "commit"]).optional(),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  planDigest: z.string().regex(/^[0-9a-f]{64}$/).optional(),
});

function field(value: FormDataEntryValue | string | null): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * POST /api/imports — upload a When I Work export (multipart `file`, or a raw
 * body with `?filename=`).
 * - `mode=preview`: counts per date, assignments that would be removed
 *   (station + hour), refusals. Writes nothing.
 * - `mode=commit` with the preview's `fingerprint` and `planDigest`: applies it;
 *   refuses if the file or the board changed since the preview.
 * - no mode: one-step import, only for a file whose dates are all new.
 */
export async function POST(request: Request) {
  const auth = await requireManagerSession(request);
  if (!auth.ok) return auth.response;
  try {
    const contentType = request.headers.get("content-type") ?? "";
    let buffer: Buffer;
    let raw: Record<string, string | undefined>;

    if (contentType.includes("multipart/form-data")) {
      const form = await request.formData();
      const file = form.get("file");
      if (!(file instanceof File)) {
        return NextResponse.json(
          { error: "Expected multipart field 'file'" },
          { status: 400 },
        );
      }
      raw = {
        filename: file.name || "upload.xlsx",
        mode: field(form.get("mode")),
        fingerprint: field(form.get("fingerprint")),
        planDigest: field(form.get("planDigest")),
      };
      buffer = Buffer.from(await file.arrayBuffer());
    } else {
      // Raw body with filename query/header fallback
      const url = new URL(request.url);
      raw = {
        filename:
          url.searchParams.get("filename") ||
          request.headers.get("x-filename") ||
          "upload.xlsx",
        mode: field(url.searchParams.get("mode")),
        fingerprint: field(url.searchParams.get("fingerprint")),
        planDigest: field(url.searchParams.get("planDigest")),
      };
      buffer = Buffer.from(await request.arrayBuffer());
    }
    const meta = metaSchema.parse(raw);

    if (!buffer.length) {
      return NextResponse.json({ error: "Empty upload" }, { status: 400 });
    }

    const parsed = await parseScheduleWorkbook(buffer, { filename: meta.filename });

    if (meta.mode === "preview") {
      const preview = await previewImport(parsed);
      return NextResponse.json({
        ...preview,
        bucketCounts: parsed.bucketCounts,
        strippedPayColumns: parsed.strippedPayColumns,
      });
    }

    if (meta.mode === "commit" && (!meta.fingerprint || !meta.planDigest)) {
      return NextResponse.json(
        { error: "Commit needs the preview's fingerprint and planDigest" },
        { status: 400 },
      );
    }
    const expected =
      meta.fingerprint && meta.planDigest
        ? { fingerprint: meta.fingerprint, planDigest: meta.planDigest }
        : undefined;
    const result = await commitImport(parsed, meta.filename, { expected });

    return NextResponse.json({
      importBatchId: result.importBatchId,
      rowCount: result.rowCount,
      bucketCounts: parsed.bucketCounts,
      dates: parsed.dates,
      preview: result.dates,
      strippedPayColumns: parsed.strippedPayColumns,
    });
  } catch (err) {
    if (err instanceof ImportRefusedError) {
      const status = err.code === "PREVIEW_REQUIRED" || err.code === "BOARD_CHANGED" ? 409 : 400;
      return NextResponse.json(
        { error: err.message, code: err.code, refusals: err.refusals },
        { status },
      );
    }
    const message = err instanceof Error ? err.message : "Import failed";
    console.error("POST /api/imports", err);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
