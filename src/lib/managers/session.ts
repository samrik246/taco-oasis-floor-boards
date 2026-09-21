import { createHmac, timingSafeEqual } from "node:crypto";

/** HMAC secret for manager session tokens. Not a manager access code. */
const SESSION_SECRET =
  process.env.MANAGER_SESSION_SECRET ?? "taco-oasis-manager-session-v1";

/** Desk/back-office and floor tokens. The floor client drops its copy on idle. */
export const MANAGER_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export type ManagerSessionClaims = {
  id: string;
  name: string;
  exp: number;
};

export function signManagerSession(
  manager: { id: string; name: string },
  ttlMs: number = MANAGER_SESSION_TTL_MS,
): string {
  const payload: ManagerSessionClaims = {
    id: manager.id,
    name: manager.name,
    exp: Date.now() + ttlMs,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", SESSION_SECRET)
    .update(body)
    .digest("base64url");
  return `${body}.${sig}`;
}

export function readManagerSession(
  token: string | null | undefined,
): ManagerSessionClaims | null {
  if (!token) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = createHmac("sha256", SESSION_SECRET)
    .update(body)
    .digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const claims = JSON.parse(
      Buffer.from(body, "base64url").toString("utf8"),
    ) as ManagerSessionClaims;
    if (!claims.id || !claims.name || typeof claims.exp !== "number") {
      return null;
    }
    if (claims.exp < Date.now()) return null;
    return claims;
  } catch {
    return null;
  }
}

export function managerSessionFromRequest(
  req: Request,
): ManagerSessionClaims | null {
  const header = req.headers.get("x-manager-session");
  return readManagerSession(header);
}

export function managerAuthHeaders(
  token?: string | null,
): Record<string, string> {
  return token ? { "x-manager-session": token } : {};
}
