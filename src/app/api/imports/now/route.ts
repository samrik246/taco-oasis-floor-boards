import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { messagesFor, type Locale } from "@/lib/i18n";
import { requireManagerSession } from "@/lib/managers/require-session";
import { interpretExportLog, kickstartArgs } from "@/lib/wiw-export/kick";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function localeOf(req: Request): Locale {
  const value = new URL(req.url).searchParams.get("locale");
  return value === "en" ? "en" : "es";
}

/** One tap starts the same LaunchAgent the hourly 06:00-21:00 timer runs. */
export async function POST(req: Request) {
  const auth = await requireManagerSession(req);
  if (!auth.ok) return auth.response;
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (uid == null) {
    return NextResponse.json({ error: messagesFor(localeOf(req)).importNowFailed }, { status: 503 });
  }
  const startedAt = new Date().toISOString();
  const kicked = await new Promise<boolean>((resolve) => {
    const child = spawn("launchctl", kickstartArgs(uid), { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
  if (!kicked) {
    return NextResponse.json({ error: messagesFor(localeOf(req)).importNowFailed }, { status: 503 });
  }
  return NextResponse.json({ ok: true, startedAt });
}

/** The result line from the export log, once the job has finished. */
export async function GET(req: Request) {
  const auth = await requireManagerSession(req);
  if (!auth.ok) return auth.response;
  const url = new URL(req.url);
  const sinceMs = Date.parse(url.searchParams.get("since") ?? "");
  if (!Number.isFinite(sinceMs)) {
    return NextResponse.json({ error: "Missing since" }, { status: 400 });
  }
  const logFile = path.join(process.cwd(), "var", "log", "wiw-export.log");
  let text = "";
  try {
    text = await readFile(logFile, "utf8");
  } catch {
    text = "";
  }
  const result = interpretExportLog(text, sinceMs, localeOf(req));
  return NextResponse.json({
    line: result?.line ?? null,
    ok: result?.ok ?? false,
    done: result != null,
  });
}
