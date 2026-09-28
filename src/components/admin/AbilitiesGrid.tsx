"use client";

import { useCallback, useEffect, useState } from "react";
import { cellWord, nextStoredLevel, type CellLevel } from "@/lib/abilities/levels";
import { managerAuthHeaders } from "@/lib/managers/auth-headers";

type Column = { key: string; label: string; kind: "family" | "station" };
type Person = {
  id: string;
  externalId: string;
  firstName: string;
  lastName: string;
  cells: Record<string, CellLevel>;
};

const CELL_CLASS: Record<CellLevel, string> = {
  forbidden: "bg-red-700 text-white",
  training: "bg-amber-500 text-neutral-950",
  ok: "bg-sky-700 text-white",
  preferred: "bg-emerald-700 text-white",
  mixed: "bg-neutral-300 text-neutral-950",
};

async function readError(res: Response): Promise<string> {
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  return data.error || "Could not save";
}

export function AbilitiesGrid({ token }: { token: string }) {
  const [columns, setColumns] = useState<Column[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/admin/abilities?board=cocina", {
      headers: managerAuthHeaders(token),
    });
    if (!res.ok) {
      setError(await readError(res));
      return;
    }
    const data = (await res.json()) as { columns: Column[]; people: Person[] };
    setColumns(data.columns);
    setPeople(data.people);
    setError(null);
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  async function tap(person: Person, column: Column) {
    const key = `${person.id}:${column.key}`;
    if (saving) return;
    const current = person.cells[column.key] ?? "ok";
    const next = nextStoredLevel(current);
    setSaving(key);
    setError(null);
    setPeople((rows) =>
      rows.map((row) =>
        row.id === person.id ? { ...row, cells: { ...row.cells, [column.key]: next } } : row,
      ),
    );
    const res = await fetch("/api/admin/abilities", {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...managerAuthHeaders(token) },
      body: JSON.stringify({ employeeId: person.id, column: column.key, level: next }),
    });
    setSaving(null);
    if (!res.ok) {
      setPeople((rows) =>
        rows.map((row) =>
          row.id === person.id ? { ...row, cells: { ...row.cells, [column.key]: current } } : row,
        ),
      );
      setError(await readError(res));
      return;
    }
  }

  return (
    <section className="flex flex-col gap-3" data-testid="abilities-grid">
      {error && (
        <p className="text-sm font-semibold text-red-900" data-testid="abilities-error">
          {error}
        </p>
      )}
      <div className="max-h-[70vh] overflow-auto rounded-md border-2 border-neutral-900">
        <table className="border-separate border-spacing-0 text-sm">
          <thead>
            <tr>
              <th className="sticky left-0 top-0 z-30 min-w-36 bg-white px-3 py-2 text-left font-black">
                Person
              </th>
              {columns.map((column) => (
                <th
                  key={column.key}
                  className="sticky top-0 z-20 bg-white px-2 py-2 text-left font-bold"
                >
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {people.map((person) => (
              <tr key={person.id} data-testid={`ability-person-${person.externalId}`}>
                <th className="sticky left-0 z-10 bg-white px-3 py-1 text-left font-bold">
                  {person.firstName} {person.lastName}
                </th>
                {columns.map((column) => {
                  const level = person.cells[column.key] ?? "ok";
                  return (
                    <td key={column.key} className="px-1 py-1">
                      <button
                        type="button"
                        className={`min-h-11 min-w-11 rounded-md px-2 text-xs font-black ${CELL_CLASS[level]}`}
                        disabled={saving === `${person.id}:${column.key}`}
                        onClick={() => void tap(person, column)}
                        data-testid={`ability-cell-${person.externalId}-${column.key}`}
                      >
                        {cellWord(level)}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
