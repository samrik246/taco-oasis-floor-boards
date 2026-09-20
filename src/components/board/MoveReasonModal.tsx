"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { MOVE_REASONS, type MoveReason } from "@/lib/position-moves";

export type PendingMove = {
  assignmentId: string;
  employeeId: string;
  employeeName: string;
  fromStationId: string;
};

type Props = {
  pending: PendingMove | null;
  onCancel: () => void;
  onConfirm: (reason: MoveReason, note: string) => void;
};

export function MoveReasonModal({ pending, onCancel, onConfirm }: Props) {
  const [reason, setReason] = useState<MoveReason>("Break");
  const [note, setNote] = useState("");

  if (!pending) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="move-reason-title"
      data-testid="move-reason-modal"
    >
      <div className="w-full max-w-md rounded-lg border-2 border-neutral-900 bg-white p-4 shadow-lg">
        <h2 id="move-reason-title" className="text-lg font-bold">
          Move off station
        </h2>
        <p className="mt-1 text-sm font-medium text-neutral-700">
          {pending.employeeName} leaving {pending.fromStationId} — pick a reason.
        </p>

        <label className="mt-4 flex flex-col gap-1 text-xs font-bold uppercase">
          Reason
          <select
            className="touch-target min-h-11 rounded-md border-2 border-neutral-900 px-2 text-sm font-semibold normal-case"
            value={reason}
            onChange={(e) => setReason(e.target.value as MoveReason)}
            data-testid="move-reason-select"
          >
            {MOVE_REASONS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>

        <label className="mt-3 flex flex-col gap-1 text-xs font-bold uppercase">
          Note (optional)
          <input
            className="touch-target min-h-11 rounded-md border-2 border-neutral-900 px-3 text-sm font-medium normal-case"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Optional detail"
            data-testid="move-reason-note"
          />
        </label>

        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            className="min-h-11 border-2"
            onClick={onCancel}
            data-testid="move-reason-cancel"
          >
            Cancel
          </Button>
          <Button
            type="button"
            className="min-h-11 border-2 border-neutral-900"
            onClick={() => onConfirm(reason, note)}
            data-testid="move-reason-confirm"
          >
            Clear station
          </Button>
        </div>
      </div>
    </div>
  );
}
