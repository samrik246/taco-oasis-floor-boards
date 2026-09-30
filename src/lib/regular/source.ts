import { readFile } from "node:fs/promises";
import path from "node:path";
import { chicagoClock } from "./clock";
import { fenceRegularPayload, type RegularOrder } from "./fence";

/**
 * Where the Regulares page gets its orders: the C3 feed's snapshot file on
 * this Mac. Off unless REGULAR_FEED_FILE names an absolute path. The boards
 * server only reads that file; it never talks to Square or Lavu and holds no
 * token.
 *
 * The feed writes the file mode 0600, so this server must run as the same
 * macOS user as the feed. A file that cannot be read (missing, wrong owner,
 * bad JSON) shows the stale banner, never a crash.
 */

export const REGULAR_STALE_AFTER_SECONDS = 300;

export type RegularSnapshot = {
  source: "off" | "file";
  /** True only when the feed's last good poll is within the stale window. */
  fresh: boolean;
  /** Feed's last good poll (ISO), or null when never read. */
  lastGoodPollAt: string | null;
  /** Same instant as HH:MM on the Chicago clock, or null. */
  lastGoodClock: string | null;
  /** Empty unless fresh: a stale feed shows the banner instead of the list. */
  orders: RegularOrder[];
  heldBack: number;
  textBlanked: number;
};

export function regularFeedFile(env: NodeJS.ProcessEnv = process.env): string | null {
  const file = env.REGULAR_FEED_FILE?.trim() ?? "";
  return file && path.isAbsolute(file) ? file : null;
}

export function regularEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return regularFeedFile(env) != null;
}

function staleAfterMs(env: NodeJS.ProcessEnv): number {
  const n = Number(env.REGULAR_STALE_AFTER_SECONDS);
  return (Number.isFinite(n) && n > 0 ? n : REGULAR_STALE_AFTER_SECONDS) * 1000;
}

function empty(source: RegularSnapshot["source"]): RegularSnapshot {
  return {
    source,
    fresh: false,
    lastGoodPollAt: null,
    lastGoodClock: null,
    orders: [],
    heldBack: 0,
    textBlanked: 0,
  };
}

export async function loadRegular(
  now: Date = new Date(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<RegularSnapshot> {
  const file = regularFeedFile(env);
  if (!file) return empty("off");
  let doc: unknown;
  try {
    doc = JSON.parse(await readFile(file, "utf8"));
  } catch {
    return empty("file");
  }
  const raw =
    doc && typeof doc === "object" ? (doc as { last_good_poll_at?: unknown }).last_good_poll_at : null;
  const lastMs = typeof raw === "string" ? Date.parse(raw) : Number.NaN;
  if (!Number.isFinite(lastMs)) return empty("file");
  const lastGoodPollAt = new Date(lastMs).toISOString();
  const lastGoodClock = chicagoClock(lastGoodPollAt);
  const age = now.getTime() - lastMs;
  const fresh = age >= -60_000 && age <= staleAfterMs(env);
  if (!fresh) return { ...empty("file"), lastGoodPollAt, lastGoodClock };
  const { orders, heldBack, textBlanked } = fenceRegularPayload(doc);
  return { source: "file", fresh, lastGoodPollAt, lastGoodClock, orders, heldBack, textBlanked };
}
