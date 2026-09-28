import { createHmac, timingSafeEqual } from "node:crypto";
import { STAFF_SESSION_HEADER } from "@/lib/breaks/header";

export const STAFF_SESSION_TTL_MS = 5 * 60 * 1000;
export { STAFF_SESSION_HEADER };

const STAFF_DOMAIN = "staff";

export type StaffSessionClaims = {
  employeeId: string;
  board: "caja" | "cocina";
  exp: number;
};

function sessionSecret(): string | null {
  const secret = process.env.MANAGER_SESSION_SECRET?.trim();
  return secret && secret.length >= 32 ? secret : null;
}

/** HMAC with a staff: prefix. The payload has no manager id or name, so readManagerSession rejects it. */
export function signStaffSession(
  input: { employeeId: string; board: "caja" | "cocina" },
  ttlMs: number = STAFF_SESSION_TTL_MS,
): string {
  const secret = sessionSecret();
  if (!secret) throw new Error("MANAGER_SESSION_SECRET must be at least 32 characters");
  const payload = {
    domain: STAFF_DOMAIN,
    employeeId: input.employeeId,
    board: input.board,
    exp: Date.now() + ttlMs,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", secret).update(body).digest("base64url");
  return `staff:${body}.${sig}`;
}

export function readStaffSession(token: string | null | undefined): StaffSessionClaims | null {
  const secret = sessionSecret();
  if (!secret || !token?.startsWith("staff:")) return null;
  const [body, sig] = token.slice("staff:".length).split(".");
  if (!body || !sig || token.slice("staff:".length).split(".").length !== 2) return null;
  const expected = createHmac("sha256", secret).update(body).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as {
      domain?: string;
      employeeId?: string;
      board?: string;
      exp?: number;
    };
    if (claims.domain !== STAFF_DOMAIN || !claims.employeeId || typeof claims.exp !== "number") return null;
    if (claims.board !== "caja" && claims.board !== "cocina") return null;
    if (claims.exp < Date.now()) return null;
    return { employeeId: claims.employeeId, board: claims.board, exp: claims.exp };
  } catch {
    return null;
  }
}

export function staffSessionFromRequest(req: Request): StaffSessionClaims | null {
  return readStaffSession(req.headers.get(STAFF_SESSION_HEADER));
}
