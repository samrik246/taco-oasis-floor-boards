import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { parseScheduleWorkbook } from "@/lib/parser/schedule-parser";
import { persistImport } from "@/lib/import/persist-import";
import { seedDemoScheduleAssignments } from "@/lib/schedule/seed-demo-assignments";

export const runtime = "nodejs";

const SAMPLE_FILENAME = "wheniwork-restaurant-export-sample.xlsx";

/**
 * GET /api/sample — import fixtures/wheniwork-restaurant-export-sample.xlsx in one click.
 * Also seats demo assignments on 2026-09-20/21 so Schedule view is filled.
 */
export async function GET() {
  try {
    const fixturePath = path.join(
      process.cwd(),
      "fixtures",
      SAMPLE_FILENAME,
    );
    if (!fs.existsSync(fixturePath)) {
      return NextResponse.json(
        { error: `Sample fixture missing: ${SAMPLE_FILENAME}` },
        { status: 500 },
      );
    }
    const buffer = fs.readFileSync(fixturePath);
    const parsed = await parseScheduleWorkbook(buffer, {
      filename: SAMPLE_FILENAME,
    });
    const { importBatchId, rowCount } = await persistImport(
      parsed,
      SAMPLE_FILENAME,
    );

    const demo = await seedDemoScheduleAssignments();

    return NextResponse.json({
      importBatchId,
      rowCount,
      bucketCounts: parsed.bucketCounts,
      dates: parsed.dates,
      strippedPayColumns: parsed.strippedPayColumns,
      sample: true,
      demoAssignmentsCreated: demo.created,
      demoAssignmentDates: demo.dates,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Sample import failed";
    console.error("GET /api/sample", err);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
