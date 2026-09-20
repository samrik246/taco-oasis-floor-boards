"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ALL_STATIONS } from "@/lib/stations";
import type { AbilityLevel } from "@/lib/rules/types";

type AbilityDto = { stationId: string; level: string };
type EmployeeDto = {
  id: string;
  externalId: string;
  firstName: string;
  lastName: string;
  email: string | null;
  abilities: AbilityDto[];
};

type Props = {
  readonly: boolean;
  board: "caja" | "cocina";
};

/**
 * Simple add/edit employee + abilities (plus existing import elsewhere).
 */
export function EmployeesPanel({ readonly, board }: Props) {
  const [open, setOpen] = useState(false);
  const [employees, setEmployees] = useState<EmployeeDto[]>([]);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [editId, setEditId] = useState<string | null>(null);
  const [abilityStation, setAbilityStation] = useState("");
  const [abilityLevel, setAbilityLevel] = useState<AbilityLevel>("ok");
  const [message, setMessage] = useState<string | null>(null);

  const boardStations = ALL_STATIONS.filter((s) => s.board === board);

  const refresh = useCallback(async () => {
    const res = await fetch("/api/employees");
    if (!res.ok) return;
    const data = (await res.json()) as { employees: EmployeeDto[] };
    setEmployees(data.employees ?? []);
  }, []);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  useEffect(() => {
    if (boardStations[0] && !abilityStation) {
      setAbilityStation(boardStations[0].id);
    }
  }, [boardStations, abilityStation]);

  async function create() {
    if (readonly || !firstName.trim() || !lastName.trim()) return;
    setMessage(null);
    const res = await fetch("/api/employees", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        abilities: boardStations.map((s) => ({
          stationId: s.id,
          level: "ok" as AbilityLevel,
        })),
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
    await refresh();
  }

  async function setAbility() {
    if (readonly || !editId || !abilityStation) return;
    const emp = employees.find((e) => e.id === editId);
    if (!emp) return;
    const next = emp.abilities.filter((a) => a.stationId !== abilityStation);
    next.push({ stationId: abilityStation, level: abilityLevel });
    const res = await fetch(`/api/employees/${editId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        abilities: next.map((a) => ({
          stationId: a.stationId,
          level: a.level as AbilityLevel,
        })),
      }),
    });
    if (!res.ok) {
      setMessage("Ability update failed");
      return;
    }
    setMessage("Ability saved");
    await refresh();
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
          <label className="flex flex-col gap-1 text-xs font-bold uppercase text-neutral-700">
            Edit abilities
            <select
              className="touch-target min-h-11 rounded-md border-2 border-neutral-800 bg-white px-2 text-sm font-semibold normal-case"
              value={editId ?? ""}
              onChange={(e) => setEditId(e.target.value || null)}
              data-testid="employee-edit-select"
            >
              <option value="">Select person</option>
              {employees.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.firstName} {e.lastName}
                </option>
              ))}
            </select>
          </label>
          {editId && (
            <div className="flex flex-wrap gap-2">
              <select
                className="touch-target min-h-11 rounded-md border-2 border-neutral-800 bg-white px-2 text-sm font-semibold"
                value={abilityStation}
                onChange={(e) => setAbilityStation(e.target.value)}
                data-testid="ability-station"
              >
                {boardStations.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
              <select
                className="touch-target min-h-11 rounded-md border-2 border-neutral-800 bg-white px-2 text-sm font-semibold"
                value={abilityLevel}
                onChange={(e) =>
                  setAbilityLevel(e.target.value as AbilityLevel)
                }
                data-testid="ability-level"
              >
                <option value="preferred">preferred</option>
                <option value="ok">ok</option>
                <option value="training">training</option>
                <option value="forbidden">forbidden</option>
              </select>
              <Button
                type="button"
                className="min-h-11 border-2"
                disabled={readonly}
                onClick={() => void setAbility()}
                data-testid="ability-save"
              >
                Set ability
              </Button>
            </div>
          )}
          {message && (
            <p className="text-sm font-semibold text-neutral-800">{message}</p>
          )}
        </div>
      )}
    </div>
  );
}
