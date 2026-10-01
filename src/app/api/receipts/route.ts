import { createHash } from "node:crypto";
import { requireManagerSession } from "@/lib/managers/require-session";
import { handleReceipt } from "@/lib/receipts/host";

export const runtime = "nodejs";

export function POST(req: Request) {
  return handleReceipt(req, {
    authenticate: async (request) => {
      const auth = await requireManagerSession(request);
      return auth.ok ? createHash("sha256").update("boards-manager:" + auth.manager.id).digest("hex").slice(0, 32) : null;
    },
    // Intentionally no real engine until its separate host/installation proof.
  });
}
