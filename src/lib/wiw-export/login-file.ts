/**
 * The locked login file for the When I Work export (B2, Rich 2A).
 *
 * XICO fills it once on the Mac. It holds two lines and nothing else:
 *
 *     email=<the When I Work sign-in email>
 *     password=<its password>
 *
 * Blank lines and lines starting with `#` are ignored. The file must be a
 * regular file (not a link) owned by the user running the job, with no group
 * or other permission bits (mode 600 or 400), and it must sit outside the app
 * folder (which holds `var/`) and outside the export and browser folders.
 *
 * Nothing here ever prints, logs or throws the file's contents. Errors carry a
 * fixed code and fixed text only. The values live in private fields and only
 * `reveal()` hands them out, to the browser step that types them.
 */
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { inspect } from "node:util";

export type LoginFileCode =
  | "NOT_SET"
  | "NOT_ABSOLUTE"
  | "MISSING"
  | "NOT_REGULAR"
  | "OWNER"
  | "MODE"
  | "INSIDE_APP"
  | "FORMAT";

const MESSAGES: Record<LoginFileCode, string> = {
  NOT_SET: "the login file path is not set",
  NOT_ABSOLUTE: "the login file path must be absolute",
  MISSING: "the login file is missing or unreadable",
  NOT_REGULAR: "the login file must be a regular file, not a link or folder",
  OWNER: "the login file must be owned by the user running the job",
  MODE: "the login file must be mode 600 (no group or other access)",
  INSIDE_APP: "the login file must sit outside the app, export and browser folders",
  FORMAT: "the login file must hold exactly one email= line and one password= line",
};

export class LoginFileError extends Error {
  constructor(readonly code: LoginFileCode) {
    super(MESSAGES[code]);
    this.name = "LoginFileError";
  }
}

const REDACTED = "[wiw login redacted]";

/** The two sign-in fields. Printing, inspecting or serializing it shows nothing. */
export class WiwLogin {
  readonly #email: string;
  readonly #password: string;

  constructor(email: string, password: string) {
    this.#email = email;
    this.#password = password;
  }

  /** For the browser step that types the fields. Never pass the result to a log. */
  reveal(): { email: string; password: string } {
    return { email: this.#email, password: this.#password };
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [inspect.custom](): string {
    return REDACTED;
  }
}

const MAX_BYTES = 4096;

function inside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

async function real(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    return path.resolve(p);
  }
}

/** Parse the file body. Throws FORMAT with no content attached. */
export function parseLoginFile(body: string): WiwLogin {
  let email: string | undefined;
  let password: string | undefined;
  for (const raw of body.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) throw new LoginFileError("FORMAT");
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1);
    if (key === "email" && email === undefined) email = value.trim();
    else if (key === "password" && password === undefined) password = value;
    else throw new LoginFileError("FORMAT");
  }
  if (!email || !password) throw new LoginFileError("FORMAT");
  return new WiwLogin(email, password);
}

/**
 * Read and check the locked file. `keepOut` lists folders it must not sit in
 * (the app folder, the export folder, the browser folder).
 */
export async function readLoginFile(
  file: string | undefined,
  opts: { keepOut: string[]; uid?: number },
): Promise<WiwLogin> {
  if (!file || file.trim() === "") throw new LoginFileError("NOT_SET");
  if (!path.isAbsolute(file)) throw new LoginFileError("NOT_ABSOLUTE");

  let info;
  try {
    info = await lstat(file);
  } catch {
    throw new LoginFileError("MISSING");
  }
  if (!info.isFile()) throw new LoginFileError("NOT_REGULAR");
  const uid = opts.uid ?? process.getuid?.();
  if (uid !== undefined && info.uid !== uid) throw new LoginFileError("OWNER");
  if ((info.mode & 0o077) !== 0) throw new LoginFileError("MODE");

  const where = await real(file);
  for (const dir of opts.keepOut) {
    if (inside(where, await real(dir))) throw new LoginFileError("INSIDE_APP");
  }
  if (info.size > MAX_BYTES) throw new LoginFileError("FORMAT");

  let body: string;
  try {
    body = await readFile(file, "utf8");
  } catch {
    throw new LoginFileError("MISSING");
  }
  return parseLoginFile(body);
}
