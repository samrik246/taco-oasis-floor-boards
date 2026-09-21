import { NextResponse } from "next/server";
import { isFloorBoardId } from "@/lib/board-config";
import { forecastForDate } from "@/lib/rush/sales-service";

export const dynamic = "force-dynamic";

/** Historical rush from sales-percent rows in SQLite (not order counts). */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const boardRaw = url.searchParams.get("board") ?? "";
    const date = url.searchParams.get("date") ?? "";
    if (!isFloorBoardId(boardRaw) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return NextResponse.json(
        { error: "board and date are required" },
        { status: 400 },
      );
    }
    const forecast = await forecastForDate(boardRaw, date);
    return NextResponse.json({ forecast, metric: "percent-of-day-sales" });
  } catch (err) {
    console.error(err);
    return NextResponse.json(
      { error: "Failed to build rush forecast" },
      { status: 500 },
    );
  }
}
