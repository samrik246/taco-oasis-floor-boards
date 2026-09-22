"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { STATION_COLORS } from "@/lib/admin/validate";
import { hourGridHours } from "@/lib/hour-grid";
import { managerAuthHeaders } from "@/lib/managers/auth-headers";

const TOKEN_KEY = "taco-oasis-back-office-session";

type StationRow = {
  id: string;
  board: string;
  label: string;
  color: string;
  shortCode: string;
  sortOrder: number;
  maxConcurrent: number;
};

type Person = {
  id: string;
  externalId: string;
  firstName: string;
  lastName: string;
  email: string | null;
  abilities: { stationId: string; level: string }[];
};

type TareaRow = {
  id: string;
  code: string;
  label: string;
  mode: string;
  board: string;
  sortOrder: number;
};

type ManagerRow = { id: string; name: string; active: boolean };

type Tab = "stations" | "people" | "tareas" | "seats" | "sales" | "managers";

const DOW = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

async function readError(res: Response): Promise<string> {
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  return data.error || `Request failed (${res.status})`;
}

export function BackOffice() {
  const [token, setToken] = useState<string | null>(null);
  const [managerName, setManagerName] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("stations");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const saved = window.sessionStorage.getItem(TOKEN_KEY);
    if (saved) setToken(saved);
    setReady(true);
  }, []);

  const auth = useMemo(() => managerAuthHeaders(token), [token]);

  function logout() {
    window.sessionStorage.removeItem(TOKEN_KEY);
    setToken(null);
    setManagerName("");
  }

  async function login() {
    setError(null);
    const res = await fetch("/api/managers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    const data = (await res.json()) as {
      ok?: boolean;
      error?: string;
      sessionToken?: string;
      manager?: { name: string };
    };
    if (!res.ok || !data.sessionToken || !data.manager) {
      setError(data.error || "Wrong manager code");
      return;
    }
    window.sessionStorage.setItem(TOKEN_KEY, data.sessionToken);
    setToken(data.sessionToken);
    setManagerName(data.manager.name);
    setCode("");
  }

  if (!ready) {
    return <p className="p-8 font-semibold">Loading back office…</p>;
  }

  if (!token) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-4 p-6">
        <h1 className="text-2xl font-black">Back office</h1>
        <p className="text-sm text-neutral-700">
          Desk editor for stations, people, tareas, the seat plan, and sales-by-hour
          percents. Floor tablets stay on the board.
        </p>
        <label className="flex flex-col gap-1 text-sm font-bold">
          Manager code
          <input
            type="password"
            autoComplete="off"
            className="min-h-11 rounded-md border-2 border-neutral-900 px-3"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            data-testid="back-office-code"
          />
        </label>
        {error && (
          <p className="text-sm font-semibold text-red-800" data-testid="back-office-error">
            {error}
          </p>
        )}
        <button
          type="button"
          className="min-h-11 rounded-md bg-neutral-900 font-bold text-white"
          onClick={() => void login()}
          data-testid="back-office-submit"
        >
          Enter
        </button>
        <Link href="/" className="text-sm font-semibold underline">
          Floor board
        </Link>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-5xl flex-col gap-4 p-6" data-testid="back-office-app">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-black">Back office</h1>
          <p className="text-sm font-semibold text-neutral-700" data-testid="back-office-manager">
            {managerName || "Manager"} · desk session · codes stay hidden
          </p>
        </div>
        <div className="flex gap-3 text-sm font-bold">
          <Link href="/" className="underline">
            Floor board
          </Link>
          <button type="button" className="underline" onClick={logout} data-testid="back-office-logout">
            Log out
          </button>
        </div>
      </header>

      <nav className="flex flex-wrap gap-2" data-testid="back-office-tabs">
        {(
          [
            ["stations", "Stations"],
            ["people", "People"],
            ["tareas", "Tareas"],
            ["seats", "Seat plan"],
            ["sales", "Sales %"],
            ["managers", "Managers"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={`min-h-10 rounded-md border-2 px-3 text-sm font-bold ${
              tab === id ? "border-neutral-900 bg-neutral-900 text-white" : "border-neutral-400"
            }`}
            onClick={() => {
              setTab(id);
              setError(null);
              setNotice(null);
            }}
            data-testid={`back-office-tab-${id}`}
          >
            {label}
          </button>
        ))}
      </nav>

      {error && (
        <p className="rounded-md border-2 border-red-800 bg-red-50 px-3 py-2 text-sm font-semibold text-red-900" data-testid="back-office-error">
          {error}
        </p>
      )}
      {notice && (
        <p className="rounded-md border-2 border-emerald-800 bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-950" data-testid="back-office-toast">
          {notice}
        </p>
      )}

      {tab === "stations" && (
        <StationsTab auth={auth} onError={setError} onSaved={(msg) => { setError(null); setNotice(msg); }} />
      )}
      {tab === "people" && (
        <PeopleTab auth={auth} onError={setError} onSaved={(msg) => { setError(null); setNotice(msg); }} />
      )}
      {tab === "tareas" && (
        <TareasTab auth={auth} onError={setError} onSaved={(msg) => { setError(null); setNotice(msg); }} />
      )}
      {tab === "seats" && (
        <SeatsTab auth={auth} onError={setError} onSaved={(msg) => { setError(null); setNotice(msg); }} />
      )}
      {tab === "sales" && (
        <SalesTab auth={auth} onError={setError} onSaved={(msg) => { setError(null); setNotice(msg); }} />
      )}
      {tab === "managers" && <ManagersTab auth={auth} onError={setError} />}
    </main>
  );
}

function StationsTab({
  auth,
  onError,
  onSaved,
}: {
  auth: Record<string, string>;
  onError: (msg: string) => void;
  onSaved: (msg: string) => void;
}) {
  const [rows, setRows] = useState<StationRow[]>([]);
  const [draft, setDraft] = useState({
    id: "",
    label: "",
    color: "gray",
    shortCode: "",
    board: "caja",
    sortOrder: 20,
  });

  const load = useCallback(async () => {
    const res = await fetch("/api/admin/stations", { headers: auth });
    if (!res.ok) {
      onError(await readError(res));
      return;
    }
    const data = (await res.json()) as { stations: StationRow[] };
    setRows(data.stations);
  }, [auth, onError]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(row: StationRow) {
    const res = await fetch(`/api/admin/stations/${row.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({
        label: row.label,
        color: row.color,
        shortCode: row.shortCode,
        board: row.board,
        sortOrder: row.sortOrder,
      }),
    });
    if (!res.ok) {
      onError(await readError(res));
      return;
    }
    onSaved(`Saved ${row.id}`);
    await load();
  }

  async function create() {
    const res = await fetch("/api/admin/stations", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify(draft),
    });
    if (!res.ok) {
      onError(await readError(res));
      return;
    }
    onSaved(`Created ${draft.id}`);
    setDraft({ id: "", label: "", color: "gray", shortCode: "", board: "caja", sortOrder: 20 });
    await load();
  }

  return (
    <section className="flex flex-col gap-4">
      <p className="text-sm text-neutral-700">
        Labels, colors, short codes, and board. One person per station stays on (max 1).
      </p>
      {rows.map((row) => (
        <div key={row.id} className="grid gap-2 rounded-md border-2 border-neutral-300 p-3 md:grid-cols-6">
          <span className="font-mono text-sm font-bold">{row.id}</span>
          <input
            className="min-h-10 rounded border-2 border-neutral-800 px-2"
            value={row.label}
            aria-label={`${row.id} label`}
            data-testid={`station-label-${row.id}`}
            onChange={(e) =>
              setRows((prev) => prev.map((item) => (item.id === row.id ? { ...item, label: e.target.value } : item)))
            }
          />
          <input
            className="min-h-10 rounded border-2 border-neutral-800 px-2 font-mono"
            value={row.shortCode}
            aria-label={`${row.id} short code`}
            data-testid={`station-code-${row.id}`}
            onChange={(e) =>
              setRows((prev) => prev.map((item) => (item.id === row.id ? { ...item, shortCode: e.target.value } : item)))
            }
          />
          <select
            className="min-h-10 rounded border-2 border-neutral-800 px-2"
            value={row.color}
            onChange={(e) =>
              setRows((prev) => prev.map((item) => (item.id === row.id ? { ...item, color: e.target.value } : item)))
            }
          >
            {STATION_COLORS.map((color) => (
              <option key={color} value={color}>{color}</option>
            ))}
          </select>
          <select
            className="min-h-10 rounded border-2 border-neutral-800 px-2"
            value={row.board}
            onChange={(e) =>
              setRows((prev) => prev.map((item) => (item.id === row.id ? { ...item, board: e.target.value } : item)))
            }
          >
            <option value="caja">caja</option>
            <option value="cocina">cocina</option>
          </select>
          <button
            type="button"
            className="min-h-10 rounded bg-neutral-900 font-bold text-white"
            onClick={() => void save(row)}
            data-testid={`station-save-${row.id}`}
          >
            Save
          </button>
        </div>
      ))}
      <div className="grid gap-2 rounded-md border-2 border-dashed border-neutral-500 p-3 md:grid-cols-6">
        <input className="min-h-10 rounded border-2 px-2" placeholder="id" value={draft.id} data-testid="station-new-id" onChange={(e) => setDraft({ ...draft, id: e.target.value })} />
        <input className="min-h-10 rounded border-2 px-2" placeholder="Label" value={draft.label} data-testid="station-new-label" onChange={(e) => setDraft({ ...draft, label: e.target.value })} />
        <input className="min-h-10 rounded border-2 px-2" placeholder="Code" value={draft.shortCode} onChange={(e) => setDraft({ ...draft, shortCode: e.target.value })} />
        <select className="min-h-10 rounded border-2 px-2" value={draft.color} onChange={(e) => setDraft({ ...draft, color: e.target.value })}>
          {STATION_COLORS.map((color) => (
            <option key={color} value={color}>{color}</option>
          ))}
        </select>
        <select className="min-h-10 rounded border-2 px-2" value={draft.board} onChange={(e) => setDraft({ ...draft, board: e.target.value })}>
          <option value="caja">caja</option>
          <option value="cocina">cocina</option>
        </select>
        <button type="button" className="min-h-10 rounded border-2 border-neutral-900 font-bold" onClick={() => void create()} data-testid="station-create">
          Add station
        </button>
      </div>
    </section>
  );
}

function PeopleTab({
  auth,
  onError,
  onSaved,
}: {
  auth: Record<string, string>;
  onError: (msg: string) => void;
  onSaved: (msg: string) => void;
}) {
  const [people, setPeople] = useState<Person[]>([]);
  const [stations, setStations] = useState<StationRow[]>([]);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [editId, setEditId] = useState("");
  const [stationId, setStationId] = useState("");
  const [level, setLevel] = useState("ok");

  const load = useCallback(async () => {
    const [peopleRes, stationRes] = await Promise.all([
      fetch("/api/employees"),
      fetch("/api/admin/stations", { headers: auth }),
    ]);
    if (!peopleRes.ok) {
      onError(await readError(peopleRes));
      return;
    }
    if (!stationRes.ok) {
      onError(await readError(stationRes));
      return;
    }
    const peopleData = (await peopleRes.json()) as { employees: Person[] };
    const stationData = (await stationRes.json()) as { stations: StationRow[] };
    setPeople(peopleData.employees);
    setStations(stationData.stations);
    setStationId((prev) => prev || stationData.stations[0]?.id || "");
  }, [auth, onError]);

  useEffect(() => {
    void load();
  }, [load]);

  async function create() {
    const res = await fetch("/api/employees", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({ firstName, lastName }),
    });
    if (!res.ok) {
      onError(await readError(res));
      return;
    }
    setFirstName("");
    setLastName("");
    onSaved("Person added");
    await load();
  }

  async function saveAbility() {
    const person = people.find((row) => row.id === editId);
    if (!person || !stationId) {
      onError("Pick a person and a station.");
      return;
    }
    const abilities = person.abilities.filter((a) => a.stationId !== stationId);
    abilities.push({ stationId, level });
    const res = await fetch(`/api/employees/${person.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({ abilities }),
    });
    if (!res.ok) {
      onError(await readError(res));
      return;
    }
    onSaved("Ability saved");
    await load();
  }

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        <input className="min-h-11 rounded border-2 px-2" placeholder="First" value={firstName} data-testid="back-office-first" onChange={(e) => setFirstName(e.target.value)} />
        <input className="min-h-11 rounded border-2 px-2" placeholder="Last" value={lastName} data-testid="back-office-last" onChange={(e) => setLastName(e.target.value)} />
        <button type="button" className="min-h-11 rounded bg-neutral-900 px-4 font-bold text-white" onClick={() => void create()} data-testid="back-office-add-person">
          Add person
        </button>
      </div>
      <div className="flex flex-wrap gap-2">
        <select className="min-h-11 rounded border-2 px-2" value={editId} data-testid="back-office-person" onChange={(e) => setEditId(e.target.value)}>
          <option value="">Person</option>
          {people.map((person) => (
            <option key={person.id} value={person.id}>
              {person.firstName} {person.lastName}
            </option>
          ))}
        </select>
        <select className="min-h-11 rounded border-2 px-2" value={stationId} onChange={(e) => setStationId(e.target.value)}>
          {stations.map((station) => (
            <option key={station.id} value={station.id}>{station.label}</option>
          ))}
        </select>
        <select className="min-h-11 rounded border-2 px-2" value={level} onChange={(e) => setLevel(e.target.value)}>
          <option value="forbidden">forbidden</option>
          <option value="training">training</option>
          <option value="ok">ok</option>
          <option value="preferred">preferred</option>
        </select>
        <button type="button" className="min-h-11 rounded border-2 border-neutral-900 px-4 font-bold" onClick={() => void saveAbility()}>
          Save ability
        </button>
      </div>
      <ul className="text-sm">
        {people.map((person) => (
          <li key={person.id} data-testid={`person-${person.externalId}`}>
            {person.firstName} {person.lastName}
          </li>
        ))}
      </ul>
    </section>
  );
}

function TareasTab({
  auth,
  onError,
  onSaved,
}: {
  auth: Record<string, string>;
  onError: (msg: string) => void;
  onSaved: (msg: string) => void;
}) {
  const [rows, setRows] = useState<TareaRow[]>([]);
  const load = useCallback(async () => {
    const res = await fetch("/api/admin/tareas", { headers: auth });
    if (!res.ok) {
      onError(await readError(res));
      return;
    }
    const data = (await res.json()) as { templates: TareaRow[] };
    setRows(data.templates);
  }, [auth, onError]);
  useEffect(() => {
    void load();
  }, [load]);

  async function save(row: TareaRow) {
    const res = await fetch("/api/admin/tareas", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({
        id: row.id,
        label: row.label,
        mode: row.mode,
        board: row.board,
        sortOrder: row.sortOrder,
      }),
    });
    if (!res.ok) {
      onError(await readError(res));
      return;
    }
    onSaved(`Saved tarea ${row.id}`);
    await load();
  }

  return (
    <section className="flex flex-col gap-2">
      {rows.map((row) => (
        <div key={row.id} className="grid gap-2 rounded border-2 border-neutral-300 p-2 md:grid-cols-[8rem_1fr_auto]">
          <span className="font-mono text-xs font-bold">{row.id}</span>
          <input
            className="min-h-10 rounded border-2 px-2"
            value={row.label}
            data-testid={`tarea-label-${row.id}`}
            onChange={(e) =>
              setRows((prev) => prev.map((item) => (item.id === row.id ? { ...item, label: e.target.value } : item)))
            }
          />
          <button type="button" className="min-h-10 rounded bg-neutral-900 px-3 font-bold text-white" onClick={() => void save(row)} data-testid={`tarea-save-${row.id}`}>
            Save
          </button>
        </div>
      ))}
    </section>
  );
}

function SeatsTab({
  auth,
  onError,
  onSaved,
}: {
  auth: Record<string, string>;
  onError: (msg: string) => void;
  onSaved: (msg: string) => void;
}) {
  const [board, setBoard] = useState<"caja" | "cocina">("caja");
  const [date, setDate] = useState("2026-09-20");
  const [hour, setHour] = useState(12);
  const [day, setDay] = useState<{
    stations: { id: string; label: string }[];
    shifts: {
      id: string;
      sourcePosition: string;
      employee: { firstName: string; lastName: string };
      assignments: { id: string; stationId: string; hourStart: string }[];
    }[];
  } | null>(null);
  const [shiftId, setShiftId] = useState("");
  const [stationId, setStationId] = useState("");

  const load = useCallback(async () => {
    const res = await fetch(`/api/boards/${board}/days/${date}`);
    if (!res.ok) {
      onError(await readError(res));
      return;
    }
    const data = await res.json();
    setDay(data);
    setShiftId(data.shifts?.[0]?.id ?? "");
    setStationId(data.stations?.[0]?.id ?? "");
  }, [board, date, onError]);

  useEffect(() => {
    void load();
  }, [load]);

  async function seat() {
    const res = await fetch("/api/admin/seat-plan", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({ shiftId, stationId, date, hour }),
    });
    if (!res.ok) {
      onError(await readError(res));
      return;
    }
    onSaved("Seated");
    await load();
  }

  return (
    <section className="flex flex-col gap-3">
      <p className="text-sm text-neutral-700">
        Same rules as the floor: one person per station, and only during their shift.
      </p>
      <div className="flex flex-wrap gap-2">
        <select className="min-h-11 rounded border-2 px-2" value={board} onChange={(e) => setBoard(e.target.value as "caja" | "cocina")}>
          <option value="caja">caja</option>
          <option value="cocina">cocina</option>
        </select>
        <input className="min-h-11 rounded border-2 px-2" type="date" value={date} onChange={(e) => setDate(e.target.value)} data-testid="seat-date" />
        <select className="min-h-11 rounded border-2 px-2" value={hour} onChange={(e) => setHour(Number(e.target.value))}>
          {hourGridHours().map((h) => (
            <option key={h} value={h}>{h}:00</option>
          ))}
        </select>
      </div>
      <div className="flex flex-wrap gap-2">
        <select className="min-h-11 min-w-48 rounded border-2 px-2" value={shiftId} onChange={(e) => setShiftId(e.target.value)} data-testid="seat-shift">
          {(day?.shifts ?? []).map((shift) => (
            <option key={shift.id} value={shift.id}>
              {shift.employee.firstName} {shift.employee.lastName}
            </option>
          ))}
        </select>
        <select className="min-h-11 rounded border-2 px-2" value={stationId} onChange={(e) => setStationId(e.target.value)} data-testid="seat-station">
          {(day?.stations ?? []).map((station) => (
            <option key={station.id} value={station.id}>{station.label}</option>
          ))}
        </select>
        <button type="button" className="min-h-11 rounded bg-neutral-900 px-4 font-bold text-white" onClick={() => void seat()} data-testid="seat-save">
          Seat
        </button>
      </div>
    </section>
  );
}

function SalesTab({
  auth,
  onError,
  onSaved,
}: {
  auth: Record<string, string>;
  onError: (msg: string) => void;
  onSaved: (msg: string) => void;
}) {
  const [board, setBoard] = useState<"caja" | "cocina">("caja");
  const [dow, setDow] = useState(1);
  const [percents, setPercents] = useState<{ hour: number; percent: number }[]>([]);

  const load = useCallback(async () => {
    const res = await fetch(`/api/admin/sales?board=${board}&dow=${dow}`, { headers: auth });
    if (!res.ok) {
      onError(await readError(res));
      return;
    }
    const data = (await res.json()) as {
      hours: { hour: number; percent: number }[];
    };
    setPercents(data.hours.map((hour) => ({ hour: hour.hour, percent: Number(hour.percent.toFixed(2)) })));
  }, [auth, board, dow, onError]);

  useEffect(() => {
    void load();
  }, [load]);

  const sum = percents.reduce((total, row) => total + row.percent, 0);

  async function save() {
    const res = await fetch("/api/admin/sales", {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({ board, dow, percents }),
    });
    if (!res.ok) {
      onError(await readError(res));
      return;
    }
    onSaved("Sales percents saved");
    await load();
  }

  return (
    <section className="flex flex-col gap-3">
      <p className="text-sm text-neutral-700">
        Each number is that hour’s share of the day’s sales, not an order count. The day must add up to about 100%.
      </p>
      <div className="flex flex-wrap gap-2">
        <select className="min-h-11 rounded border-2 px-2" value={board} onChange={(e) => setBoard(e.target.value as "caja" | "cocina")}>
          <option value="caja">caja</option>
          <option value="cocina">cocina</option>
        </select>
        <select className="min-h-11 rounded border-2 px-2" value={dow} onChange={(e) => setDow(Number(e.target.value))} data-testid="sales-dow">
          {DOW.map((name, index) => (
            <option key={name} value={index}>{name}</option>
          ))}
        </select>
        <span className="self-center text-sm font-bold" data-testid="sales-sum">
          Sum {sum.toFixed(1)}%
        </span>
        <button type="button" className="min-h-11 rounded bg-neutral-900 px-4 font-bold text-white" onClick={() => void save()} data-testid="sales-save">
          Save percents
        </button>
      </div>
      <div className="grid grid-cols-3 gap-2 md:grid-cols-5">
        {percents.map((row) => (
          <label key={row.hour} className="flex flex-col text-xs font-bold">
            {row.hour}:00
            <input
              className="min-h-10 rounded border-2 px-2"
              type="number"
              min={0}
              max={100}
              step="0.1"
              value={row.percent}
              data-testid={`sales-hour-${row.hour}`}
              onChange={(e) =>
                setPercents((prev) =>
                  prev.map((item) =>
                    item.hour === row.hour ? { ...item, percent: Number(e.target.value) } : item,
                  ),
                )
              }
            />
          </label>
        ))}
      </div>
    </section>
  );
}

function ManagersTab({
  auth,
  onError,
}: {
  auth: Record<string, string>;
  onError: (msg: string) => void;
}) {
  const [rows, setRows] = useState<ManagerRow[]>([]);
  const [newName, setNewName] = useState("");
  const [newCode, setNewCode] = useState("");
  const [replacementCodes, setReplacementCodes] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    const res = await fetch("/api/admin/managers", { headers: auth });
    if (!res.ok) {
      onError(await readError(res));
      return;
    }
    const data = (await res.json()) as { managers: ManagerRow[] };
    setRows(data.managers);
  }, [auth, onError]);

  useEffect(() => {
    void load();
  }, [load]);

  async function createManager() {
    const res = await fetch("/api/admin/managers", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({ name: newName, code: newCode }),
    });
    if (!res.ok) {
      onError(await readError(res));
      return;
    }
    setNewName("");
    setNewCode("");
    await load();
  }

  async function updateManager(id: string, input: { code?: string; active?: boolean }) {
    const res = await fetch(`/api/admin/managers/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      onError(await readError(res));
      return;
    }
    if (input.code != null) {
      setReplacementCodes((current) => ({ ...current, [id]: "" }));
    }
    await load();
  }

  return (
    <section className="flex flex-col gap-3">
      <p className="mb-3 text-sm text-neutral-700">
        Add a manager, rotate a code, or deactivate old access here. Codes are sent only to
        create or rotate access; stored hashes are never loaded into this page.
      </p>
      <div className="flex flex-wrap gap-2 rounded border-2 border-neutral-300 p-3">
        <input
          className="min-h-11 rounded border-2 px-2"
          placeholder="Manager name"
          value={newName}
          onChange={(event) => setNewName(event.target.value)}
          data-testid="manager-new-name"
        />
        <input
          className="min-h-11 rounded border-2 px-2"
          type="password"
          autoComplete="new-password"
          placeholder="New code"
          value={newCode}
          onChange={(event) => setNewCode(event.target.value)}
          data-testid="manager-new-code"
        />
        <button
          type="button"
          className="min-h-11 rounded bg-neutral-900 px-4 font-bold text-white"
          disabled={!newName.trim() || newCode.length < 4}
          onClick={() => void createManager()}
          data-testid="manager-create"
        >
          Add manager
        </button>
      </div>
      <ul className="flex flex-col gap-1" data-testid="manager-list">
        {rows.map((row) => (
          <li key={row.id} className="flex flex-wrap items-center gap-2 rounded border p-2" data-testid={`manager-${row.name}`}>
            <span className="font-semibold">{row.name} · {row.active ? "active" : "inactive"}</span>
            <input
              className="min-h-10 rounded border px-2"
              type="password"
              autoComplete="new-password"
              placeholder="Replacement code"
              value={replacementCodes[row.id] ?? ""}
              onChange={(event) =>
                setReplacementCodes((current) => ({ ...current, [row.id]: event.target.value }))
              }
              data-testid={`manager-code-${row.id}`}
            />
            <button
              type="button"
              className="min-h-10 rounded border-2 px-3 text-sm font-bold"
              disabled={(replacementCodes[row.id] ?? "").length < 4}
              onClick={() => void updateManager(row.id, { code: replacementCodes[row.id] })}
              data-testid={`manager-rotate-${row.id}`}
            >
              Rotate code
            </button>
            <button
              type="button"
              className="min-h-10 rounded border-2 px-3 text-sm font-bold"
              onClick={() => void updateManager(row.id, { active: !row.active })}
              data-testid={`manager-active-${row.id}`}
            >
              {row.active ? "Deactivate" : "Activate"}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
