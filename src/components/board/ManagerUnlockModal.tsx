"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import type { Messages } from "@/lib/i18n";

type Props = {
  open: boolean;
  t: Messages;
  onCancel: () => void;
  onUnlocked: (manager: { id: string; name: string }, idleMs: number) => void;
};

/**
 * Manager personal-code gate. Codes verified server-side (hashed in DB).
 */
export function ManagerUnlockModal({
  open,
  t,
  onCancel,
  onUnlocked,
}: Props) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setCode("");
      setError(null);
      setBusy(false);
    }
  }, [open]);

  if (!open) return null;

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/managers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        error?: string;
        manager?: { id: string; name: string };
        idleMs?: number;
      };
      if (!res.ok || !data.ok || !data.manager) {
        setError(t.wrongCode);
        setBusy(false);
        return;
      }
      onUnlocked(data.manager, data.idleMs ?? 15_000);
    } catch {
      setError(t.wrongCode);
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="manager-unlock-title"
      data-testid="manager-unlock-modal"
    >
      <div className="w-full max-w-sm rounded-lg border-2 border-neutral-900 bg-white p-4 shadow-lg">
        <h2 id="manager-unlock-title" className="text-lg font-bold">
          {t.unlockManager}
        </h2>
        <p className="mt-1 text-sm font-medium text-neutral-700">
          {t.managerCodeHint}
        </p>

        <label className="mt-4 flex flex-col gap-1 text-xs font-bold uppercase">
          {t.managerCode}
          <input
            type="password"
            inputMode="numeric"
            autoComplete="off"
            className="touch-target min-h-11 rounded-md border-2 border-neutral-900 px-3 text-base font-semibold normal-case tracking-widest"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit();
            }}
            data-testid="manager-code-input"
            autoFocus
          />
        </label>

        {error && (
          <p
            className="mt-2 text-sm font-bold text-red-800"
            data-testid="manager-code-error"
            role="alert"
          >
            {error}
          </p>
        )}

        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            className="min-h-11 border-2"
            onClick={onCancel}
            data-testid="manager-unlock-cancel"
          >
            {t.cancel}
          </Button>
          <Button
            type="button"
            className="min-h-11 border-2 border-neutral-900"
            disabled={busy || code.trim().length === 0}
            onClick={() => void submit()}
            data-testid="manager-unlock-submit"
          >
            {t.unlock}
          </Button>
        </div>
      </div>
    </div>
  );
}
