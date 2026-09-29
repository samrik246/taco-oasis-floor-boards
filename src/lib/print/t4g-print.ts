import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * T4G Imprimir (Rich 1B 2B 3A 4A). The floor-boards server hands one C1
 * order-sheet model to the packing-ticket CLI on this host; that CLI owns the
 * printer, the station map and the print ledger. This file never names a
 * printer address: the printer lives only in the packing-ticket config.
 *
 * Dark by default. T4G_PRINT=on needs all of:
 *   T4G_PRINT_PYTHON        absolute path to the packing-ticket Python
 *   T4G_PRINT_DIR           absolute path to the packing-ticket checkout
 *   T4G_PRINT_CONFIG        absolute path to its three_part config JSON
 *   T4G_PRINT_MODEL_SOURCE  "fixture" (sheet waits on the C1 model read)
 * Anything missing or relative keeps printing off.
 */

export const TAIL_RE = /^[A-Za-z0-9]{4,8}$/;
export const PRINT_TIMEOUT_MS = 30_000;
const STATUS_TIMEOUT_MS = 10_000;
const MAX_OUTPUT = 64 * 1024;

export type PrintStatus = "ok" | "blocked" | "uncertain" | "locked" | "busy" | "refused";
const STATUSES: readonly PrintStatus[] = ["ok", "blocked", "uncertain", "locked", "busy", "refused"];

export type PrintConfig = {
  python: string;
  dir: string;
  config: string;
  modelSource: "fixture";
};

/** What the tablet may see. Never the model, the name, or the child's stderr. */
export type TapResult = {
  status: PrintStatus;
  id_tail: string;
  cambio: boolean;
  problems: string[];
  locked_until: string | null;
};

export type LedgerState = {
  printed: boolean;
  locked_until: string | null;
};

type Env = Record<string, string | undefined>;

export function printConfigFromEnv(env: Env = process.env): PrintConfig | null {
  if (env.T4G_PRINT !== "on") return null;
  const python = env.T4G_PRINT_PYTHON?.trim() ?? "";
  const dir = env.T4G_PRINT_DIR?.trim() ?? "";
  const config = env.T4G_PRINT_CONFIG?.trim() ?? "";
  if (![python, dir, config].every((p) => p && path.isAbsolute(p))) return null;
  if (env.T4G_PRINT_MODEL_SOURCE !== "fixture") return null;
  return { python, dir, config, modelSource: "fixture" };
}

/**
 * The child gets an explicit allow-list, never the server's env: no BUZZ_*,
 * no C1 key, no manager secret.
 */
export function childEnv(cfg: PrintConfig): Record<string, string> {
  return {
    PATH: "/usr/bin:/bin",
    PYTHONPATH: cfg.dir,
    PYTHONIOENCODING: "utf-8",
    LANG: "en_US.UTF-8",
  };
}

export class PrintModelError extends Error {}

/** The C1 order-sheet model for one tail. Fixture only until C1 serves it. */
export async function loadPrintModel(
  tail: string,
  cfg: PrintConfig,
  root: string = process.cwd(),
): Promise<Record<string, unknown>> {
  if (!TAIL_RE.test(tail)) throw new PrintModelError("bad tail");
  let raw: string;
  try {
    raw = await readFile(path.join(root, "fixtures", "square-next", "print-models", `${tail}.json`), "utf8");
  } catch {
    throw new PrintModelError("no model");
  }
  let model: unknown;
  try {
    model = JSON.parse(raw);
  } catch {
    throw new PrintModelError("model is not JSON");
  }
  if (!model || typeof model !== "object" || Array.isArray(model)) {
    throw new PrintModelError("model is not an object");
  }
  const rec = model as Record<string, unknown>;
  if (rec.idTail !== tail) throw new PrintModelError("model tail mismatch");
  return rec;
}

export type ExecFileLike = (
  file: string,
  args: string[],
  options: {
    cwd: string;
    env: Record<string, string>;
    timeout: number;
    maxBuffer: number;
    windowsHide: boolean;
  },
  callback: (error: Error | null, stdout: string, stderr: string) => void,
) => { stdin: NodeJS.WritableStream | null };

const realExecFile = execFile as unknown as ExecFileLike;

function uncertain(tail: string, why: string): TapResult {
  return { status: "uncertain", id_tail: tail, cambio: false, problems: [why], locked_until: null };
}

/** One JSON line or nothing. */
function parseOneLine(stdout: string): Record<string, unknown> | null {
  const lines = stdout.split("\n").filter((l) => l.trim() !== "");
  if (lines.length !== 1) return null;
  try {
    const obj = JSON.parse(lines[0]) as unknown;
    return obj && typeof obj === "object" && !Array.isArray(obj) ? (obj as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && /^[a-z_]{1,40}$/.test(v)) : [];
}

function isoOrNull(value: unknown): string | null {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value) ? value : null;
}

/**
 * Run one Imprimir tap. A non-zero exit, a timeout, or anything but one
 * well-formed JSON line is uncertain: bytes may have reached the printer.
 */
export function runPrint(
  model: Record<string, unknown>,
  tail: string,
  cfg: PrintConfig,
  exec: ExecFileLike = realExecFile,
): Promise<TapResult> {
  return new Promise((resolve) => {
    let child: { stdin: NodeJS.WritableStream | null };
    try {
      child = exec(
        cfg.python,
        ["-m", "packing_ticket.three_part", "--model", "-", "--config", cfg.config],
        { cwd: cfg.dir, env: childEnv(cfg), timeout: PRINT_TIMEOUT_MS, maxBuffer: MAX_OUTPUT, windowsHide: true },
        (error, stdout) => {
          if (error) return resolve(uncertain(tail, "no_result"));
          const out = parseOneLine(String(stdout));
          const status = out?.status;
          if (!out || typeof status !== "string" || !STATUSES.includes(status as PrintStatus)) {
            return resolve(uncertain(tail, "no_result"));
          }
          if (status !== "refused" && out.id_tail !== tail) return resolve(uncertain(tail, "no_result"));
          resolve({
            status: status as PrintStatus,
            id_tail: tail,
            cambio: out.cambio === true,
            problems: strings(out.problems),
            locked_until: isoOrNull(out.locked_until),
          });
        },
      );
    } catch {
      return resolve(uncertain(tail, "no_result"));
    }
    child.stdin?.on("error", () => {
      /* the exit callback decides the outcome */
    });
    child.stdin?.end(JSON.stringify(model));
  });
}

/** Ledger read for the button label. Sends nothing to a printer. */
export function readLedger(
  tail: string,
  cfg: PrintConfig,
  exec: ExecFileLike = realExecFile,
): Promise<LedgerState | null> {
  return new Promise((resolve) => {
    let child: { stdin: NodeJS.WritableStream | null };
    try {
      child = exec(
        cfg.python,
        ["-m", "packing_ticket.three_part", "--status", "--config", cfg.config, "--tail", tail],
        { cwd: cfg.dir, env: childEnv(cfg), timeout: STATUS_TIMEOUT_MS, maxBuffer: MAX_OUTPUT, windowsHide: true },
        (error, stdout) => {
          if (error) return resolve(null);
          const out = parseOneLine(String(stdout));
          if (!out || out.id_tail !== tail || typeof out.printed !== "boolean") return resolve(null);
          resolve({ printed: out.printed, locked_until: isoOrNull(out.locked_until) });
        },
      );
    } catch {
      return resolve(null);
    }
    child.stdin?.end();
  });
}
