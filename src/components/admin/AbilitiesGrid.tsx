"use client";

import { useCallback, useEffect, useState } from "react";
import { cellWord, nextStoredLevel, type CellLevel } from "@/lib/abilities/levels";
import { stationColorClass } from "@/components/board/board-helpers";
import { managerAuthHeaders } from "@/lib/managers/auth-headers";

type Column = { key: string; label: string; kind: "family" | "station"; color: string };
type Setting = { key: string; hidden: boolean; defaultLevel: "ok" | "forbidden" };
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
  const [settings, setSettings] = useState<Setting[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [showHidden, setShowHidden] = useState(false);
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
    const data = (await res.json()) as { columns: Column[]; settings?: Setting[]; people: Person[] };
    setColumns(data.columns);
    setSettings(data.settings ?? []);
    setPeople(data.people);
    setError(null);
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  function settingFor(key: string): Setting {
    return settings.find((row) => row.key === key) ?? { key, hidden: false, defaultLevel: "ok" };
  }

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

  async function saveSetting(key: string, patch: Partial<Pick<Setting, "hidden" | "defaultLevel">>) {
    if (saving) return;
    const previous = settings;
    const current = settingFor(key);
    const next = { ...current, ...patch };
    setSaving(`setting:${key}`);
    setError(null);
    setSettings((rows) => {
      const without = rows.filter((row) => row.key !== key);
      return [...without, next];
    });
    const res = await fetch("/api/admin/ability-columns", {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...managerAuthHeaders(token) },
      body: JSON.stringify({ key, ...patch }),
    });
    setSaving(null);
    if (!res.ok) {
      setSettings(previous);
      setError(await readError(res));
      return;
    }
    await load();
  }

  const hiddenCount = columns.filter((column) => settingFor(column.key).hidden).length;
  const visible = columns.filter((column) => showHidden || !settingFor(column.key).hidden);

  return (
    <section className="flex flex-col gap-3" data-testid="abilities-grid">
      {error && (
        <p className="text-sm font-semibold text-red-900" data-testid="abilities-error">
          {error}
        </p>
      )}
      <div>
        <button
          type="button"
          className="min-h-11 rounded-md border-2 border-neutral-900 bg-white px-3 text-sm font-black"
          aria-pressed={showHidden}
          onClick={() => setShowHidden((on) => !on)}
          data-testid="ability-show-hidden"
        >
          Mostrar ocultas ({hiddenCount})
        </button>
      </div>
      <div className="max-h-[70vh] overflow-auto rounded-md border-2 border-neutral-900">
        <table className="border-separate border-spacing-0 text-sm">
          <thead>
            <tr>
              <th className="sticky left-0 top-0 z-30 min-w-36 bg-white px-3 py-2 text-left font-black">
                Person
              </th>
              {visible.map((column) => {
                const setting = settingFor(column.key);
                const faded = setting.hidden ? "opacity-40" : "";
                return (
                  <th
                    key={column.key}
                    className={`sticky top-0 z-20 min-w-28 border-b-2 px-2 py-2 text-left font-bold ${stationColorClass(column.color)} ${faded}`}
                    data-testid={`ability-header-${column.key}`}
                    data-hidden={setting.hidden ? "1" : "0"}
                  >
                    <span className="block">{column.label}</span>
                    <span className="mt-1 flex flex-col items-start gap-1">
                      <button
                        type="button"
                        className="rounded border border-current bg-white/80 px-1 text-[11px] font-black text-neutral-950"
                        disabled={saving === `setting:${column.key}`}
                        onClick={() => void saveSetting(column.key, { hidden: !setting.hidden })}
                        data-testid={`ability-hide-${column.key}`}
                      >
                        {setting.hidden ? "Mostrar" : "Ocultar"}
                      </button>
                      <button
                        type="button"
                        className="rounded border border-current bg-white/80 px-1 text-[11px] font-black text-neutral-950"
                        disabled={saving === `setting:${column.key}`}
                        onClick={() => void saveSetting(column.key, {
                          defaultLevel: setting.defaultLevel === "forbidden" ? "ok" : "forbidden",
                        })}
                        data-testid={`ability-default-${column.key}`}
                      >
                        Nuevos: {setting.defaultLevel === "forbidden" ? "no" : "bien"}
                      </button>
                    </span>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {people.map((person, index) => {
              const stripe = index % 2 === 0 ? "bg-white" : "bg-neutral-200";
              return (
                <tr key={person.id} data-testid={`ability-person-${person.externalId}`} data-stripe={index % 2 === 0 ? "white" : "grey"}>
                  <th
                    className={`sticky left-0 z-10 px-3 py-1 text-left font-bold ${stripe}`}
                    data-testid={`ability-name-${person.externalId}`}
                  >
                    {person.firstName} {person.lastName}
                  </th>
                  {visible.map((column) => {
                    const level = person.cells[column.key] ?? "ok";
                    const faded = settingFor(column.key).hidden ? "opacity-40" : "";
                    return (
                      <td key={column.key} className={`px-1 py-1 ${stripe} ${faded}`}>
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
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
