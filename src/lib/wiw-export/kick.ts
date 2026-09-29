import { WIW_EXPORT_LABEL } from "./launch-agent";
import type { Locale } from "@/lib/i18n";
import { messagesFor } from "@/lib/i18n";

/** `launchctl kickstart -k gui/<uid>/com.taco-oasis.wiw-export` */
export function kickstartArgs(uid: number): string[] {
  return ["kickstart", "-k", `gui/${uid}/${WIW_EXPORT_LABEL}`];
}

const LOG_LINE = /^(\d{4}-\d{2}-\d{2}T\S+) wiw-export (.+)$/;

/**
 * The newest terminal line in the export log at or after `sinceMs`.
 * A start line is not a result. Exit 0 is done; a stop or any other end is stopped.
 */
export function interpretExportLog(
  text: string,
  sinceMs: number,
  locale: Locale,
): { line: string; ok: boolean } | null {
  const copy = messagesFor(locale);
  let found: { line: string; ok: boolean } | null = null;
  for (const raw of text.split("\n")) {
    const match = LOG_LINE.exec(raw.trim());
    if (!match) continue;
    const at = Date.parse(match[1]);
    if (!Number.isFinite(at) || at < sinceMs) continue;
    const body = match[2];
    if (body.startsWith("end exit=0")) found = { line: copy.importNowDone, ok: true };
    else if (
      body.startsWith("end exit=") ||
      body.startsWith("stop=") ||
      body.startsWith("error=")
    ) {
      found = { line: copy.importNowStopped, ok: false };
    }
  }
  return found;
}
