"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

type Props = {
  readonly: boolean;
  authHeaders?: Record<string, string>;
};

/**
 * Add a person. Ability levels live on the owner Habilidades grid.
 */
export function EmployeesPanel({ readonly, authHeaders }: Props) {
  const [open, setOpen] = useState(false);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  async function create() {
    if (readonly || !firstName.trim() || !lastName.trim()) return;
    setMessage(null);
    const res = await fetch("/api/employees", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify({
        firstName: firstName.trim(),
        lastName: lastName.trim(),
      }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setMessage(data.error ?? "Create failed");
      return;
    }
    setFirstName("");
    setLastName("");
    setMessage("Employee added");
  }

  return (
    <div
      className="rounded-lg border-2 border-neutral-900 bg-white p-3"
      data-testid="employees-panel"
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-lg font-bold">People</h2>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="min-h-11 border-2"
          onClick={() => setOpen((v) => !v)}
          data-testid="employees-toggle"
        >
          {open ? "Hide" : "Add / edit"}
        </Button>
      </div>
      {open && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-2">
            <input
              className="touch-target min-h-11 min-w-[8rem] flex-1 rounded-md border-2 border-neutral-800 px-2"
              placeholder="First"
              value={firstName}
              disabled={readonly}
              onChange={(e) => setFirstName(e.target.value)}
              data-testid="employee-first"
            />
            <input
              className="touch-target min-h-11 min-w-[8rem] flex-1 rounded-md border-2 border-neutral-800 px-2"
              placeholder="Last"
              value={lastName}
              disabled={readonly}
              onChange={(e) => setLastName(e.target.value)}
              data-testid="employee-last"
            />
            <Button
              type="button"
              className="min-h-11 border-2 border-neutral-900"
              disabled={readonly}
              onClick={() => void create()}
              data-testid="employee-create"
            >
              Add
            </Button>
          </div>
          {message && (
            <p className="text-sm font-semibold text-neutral-800">{message}</p>
          )}
        </div>
      )}
    </div>
  );
}
