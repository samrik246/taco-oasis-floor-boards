"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { fetchCompatibleBoard } from "@/lib/quarter/client/transport";
import { saveHourControl } from "@/lib/quarter/client/controls";
import type { DayBoardDto } from "@/components/board/types";
import { AbilitiesGrid } from "@/components/admin/AbilitiesGrid";
import { ScheduleFileUpload } from "@/components/admin/ScheduleFileUpload";
import { TurnosTab } from "@/components/admin/TurnosTab";
import {
  BackOfficeCopyProvider,
  backOfficeCopy,
  presentBackOfficeError,
  useBackOfficeCopy,
} from "@/components/admin/back-office-copy";
import { STATION_COLORS } from "@/lib/admin/validate";
import { hourGridHours } from "@/lib/hour-grid";
import type { Locale } from "@/lib/i18n";
import { readLocalePreference, saveLocalePreference } from "@/lib/locale-preference";
import { managerAuthHeaders } from "@/lib/managers/auth-headers";
import { useManagerIdle } from "@/components/board/useManagerSession";

const TOKEN_KEY = "taco-oasis-back-office-session";
/** Written at login for display. Idle and the owner tabs follow the server, never this key. */
const ROLE_KEY = "taco-oasis-back-office-role";
const IDLE_KEY = "taco-oasis-back-office-idle-ms";
type DeskRole = "unknown" | "owner" | "manager";

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
};

type TareaRow = {
  id: string;
  code: string;
  label: string;
  mode: string;
  board: string;
  sortOrder: number;
};

type ManagerRow = { id: string; name: string; active: boolean; longIdle: boolean; role: string };

type Tab = "stations" | "people" | "tareas" | "seats" | "sales" | "habilidades" | "managers" | "cambios" | "positions" | "turnos";

type ChangeRow = {
  id: string;
  createdAt: string;
  who: string;
  what: string;
  date: string;
  kind: "change" | "removal";
};

type PositionMapRow = {
  position: string;
  board: "caja" | "cocina" | null;
  eligible: boolean;
  stationId: string | null;
};

type StationOption = { id: string; board: string; label: string };

async function readError(res: Response): Promise<string> {
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  return data.error || `Request failed (${res.status})`;
}

export function BackOffice() {
  const [locale, setLocale] = useState<Locale>("es");
  useEffect(() => {
    setLocale(readLocalePreference());
  }, []);
  return (
    <BackOfficeCopyProvider copy={backOfficeCopy(locale)}>
      <BackOfficeScreen
        locale={locale}
        onLocale={(next) => {
          saveLocalePreference(next);
          setLocale(next);
        }}
      />
    </BackOfficeCopyProvider>
  );
}

function BackOfficeScreen({
  locale,
  onLocale,
}: {
  locale: Locale;
  onLocale: (locale: Locale) => void;
}) {
  const copy = useBackOfficeCopy();
  const [token, setToken] = useState<string | null>(null);
  const [deskRole, setDeskRole] = useState<DeskRole>("unknown");
  const [idleMs, setIdleMs] = useState(15_000);
  const [managerName, setManagerName] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("stations");
  const [ready, setReady] = useState(false);

  const clearDesk = useCallback(() => {
    window.sessionStorage.removeItem(TOKEN_KEY);
    window.sessionStorage.removeItem(ROLE_KEY);
    window.sessionStorage.removeItem(IDLE_KEY);
    setToken(null);
    setDeskRole("unknown");
    setManagerName("");
  }, []);

  useEffect(() => {
    const saved = window.sessionStorage.getItem(TOKEN_KEY);
    const savedIdle = Number(window.sessionStorage.getItem(IDLE_KEY));
    if (saved) setToken(saved);
    if (Number.isFinite(savedIdle) && savedIdle >= 100) setIdleMs(savedIdle);
    setReady(true);
  }, []);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/admin/managers", { headers: managerAuthHeaders(token) });
        if (cancelled) return;
        if (res.status === 200) setDeskRole("owner");
        else if (res.status === 403) setDeskRole("manager");
        else if (res.status === 401) clearDesk();
        else setDeskRole("unknown");
      } catch {
        if (!cancelled) setDeskRole("unknown");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, clearDesk]);

  const auth = useMemo(() => managerAuthHeaders(token), [token]);

  useManagerIdle({
    idleMs,
    active: token != null && deskRole !== "manager",
    onIdle: clearDesk,
  });

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
      manager?: { name: string; role?: string };
      idleMs?: number;
    };
    if (!res.ok || !data.sessionToken || !data.manager) {
      setError(presentBackOfficeError(data.error || copy.wrongCode, copy));
      return;
    }
    const nextRole: DeskRole = data.manager.role === "owner" ? "owner" : "manager";
    window.sessionStorage.setItem(TOKEN_KEY, data.sessionToken);
    window.sessionStorage.setItem(ROLE_KEY, nextRole);
    if (typeof data.idleMs === "number") {
      window.sessionStorage.setItem(IDLE_KEY, String(data.idleMs));
      setIdleMs(data.idleMs);
    }
    setToken(data.sessionToken);
    setDeskRole(nextRole);
    setManagerName(data.manager.name);
    setCode("");
  }

  if (!ready) {
    return <p className="p-8 font-semibold">{copy.loading}</p>;
  }

  if (!token) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-4 p-6">
        <h1 className="text-2xl font-black">{copy.title}</h1>
        <p className="text-sm text-neutral-700">
          {copy.intro}
        </p>
        <label className="flex flex-col gap-1 text-sm font-bold">
          {copy.managerCode}
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
          {copy.enter}
        </button>
        <Link href="/" className="text-sm font-semibold underline">
          {copy.floorBoard}
        </Link>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-5xl flex-col gap-4 p-6" data-testid="back-office-app">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-black">{copy.title}</h1>
          <p className="text-sm font-semibold text-neutral-700" data-testid="back-office-manager">
            {copy.session(managerName || copy.manager)}
          </p>
        </div>
        <div className="flex items-center gap-3 text-sm font-bold">
          <ScheduleFileUpload token={token} locale={locale} />
          <button
            type="button"
            className="underline"
            onClick={() => onLocale(locale === "es" ? "en" : "es")}
            data-testid="back-office-locale"
          >
            {locale === "es" ? "EN" : "ES"}
          </button>
          <Link href="/" className="underline">
            {copy.floorBoard}
          </Link>
          <button type="button" className="underline" onClick={clearDesk} data-testid="back-office-logout">
            {copy.logOut}
          </button>
        </div>
      </header>

      <nav className="flex flex-wrap gap-2" data-testid="back-office-tabs">
        {([
            "stations",
            "people",
            "tareas",
            "seats",
            "sales",
            ...(deskRole === "owner" ? (["habilidades", "managers", "cambios"] as Tab[]) : []),
            "positions",
            "turnos",
          ] as Tab[]).map((id) => (
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
            {copy.tabs[id]}
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
        <StationsTab auth={auth} onError={(msg) => setError(presentBackOfficeError(msg, copy))} onSaved={(msg) => { setError(null); setNotice(msg); }} />
      )}
      {tab === "people" && (
        <PeopleTab auth={auth} onError={(msg) => setError(presentBackOfficeError(msg, copy))} onSaved={(msg) => { setError(null); setNotice(msg); }} />
      )}
      {tab === "tareas" && (
        <TareasTab auth={auth} onError={(msg) => setError(presentBackOfficeError(msg, copy))} onSaved={(msg) => { setError(null); setNotice(msg); }} />
      )}
      {tab === "seats" && (
        <SeatsTab auth={auth} onError={(msg) => setError(presentBackOfficeError(msg, copy))} onSaved={(msg) => { setError(null); setNotice(msg); }} />
      )}
      {tab === "sales" && (
        <SalesTab auth={auth} onError={(msg) => setError(presentBackOfficeError(msg, copy))} onSaved={(msg) => { setError(null); setNotice(msg); }} />
      )}
      {(tab === "habilidades" || tab === "managers" || tab === "cambios") && deskRole !== "owner" && (
        <p className="text-sm font-semibold text-red-900" data-testid="owner-code-required">
          {copy.ownerRequired}
        </p>
      )}
      {tab === "habilidades" && deskRole === "owner" && token && <AbilitiesGrid token={token} />}
      {tab === "managers" && deskRole === "owner" && <ManagersTab auth={auth} onError={(msg) => setError(presentBackOfficeError(msg, copy))} />}
      {tab === "cambios" && deskRole === "owner" && <CambiosTab auth={auth} onError={(msg) => setError(presentBackOfficeError(msg, copy))} />}
      {tab === "positions" && (
        <PositionsTab auth={auth} onError={(msg) => setError(presentBackOfficeError(msg, copy))} onSaved={(msg) => { setError(null); setNotice(msg); }} />
      )}
      {tab === "turnos" && token && <TurnosTab token={token} />}
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
  const copy = useBackOfficeCopy();
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
    onSaved(copy.savedStation(row.id));
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
    onSaved(copy.createdStation(draft.id));
    setDraft({ id: "", label: "", color: "gray", shortCode: "", board: "caja", sortOrder: 20 });
    await load();
  }

  return (
    <section className="flex flex-col gap-4">
      <p className="text-sm text-neutral-700">
        {copy.stationsHelp}
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
            {copy.save}
          </button>
        </div>
      ))}
      <div className="grid gap-2 rounded-md border-2 border-dashed border-neutral-500 p-3 md:grid-cols-6">
        <input className="min-h-10 rounded border-2 px-2" placeholder="id" value={draft.id} data-testid="station-new-id" onChange={(e) => setDraft({ ...draft, id: e.target.value })} />
        <input className="min-h-10 rounded border-2 px-2" placeholder={copy.labelPh} value={draft.label} data-testid="station-new-label" onChange={(e) => setDraft({ ...draft, label: e.target.value })} />
        <input className="min-h-10 rounded border-2 px-2" placeholder={copy.codePh} value={draft.shortCode} onChange={(e) => setDraft({ ...draft, shortCode: e.target.value })} />
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
          {copy.addStation}
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
  const copy = useBackOfficeCopy();
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");

  const load = useCallback(async () => {
    const peopleRes = await fetch("/api/employees", { headers: auth });
    if (!peopleRes.ok) {
      onError(await readError(peopleRes));
      return;
    }
    const peopleData = (await peopleRes.json()) as { employees: Person[] };
    setPeople(peopleData.employees);
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
    onSaved(copy.personAdded);
    await load();
  }

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        <input className="min-h-11 rounded border-2 px-2" placeholder={copy.firstPh} value={firstName} data-testid="back-office-first" onChange={(e) => setFirstName(e.target.value)} />
        <input className="min-h-11 rounded border-2 px-2" placeholder={copy.lastPh} value={lastName} data-testid="back-office-last" onChange={(e) => setLastName(e.target.value)} />
        <button type="button" className="min-h-11 rounded bg-neutral-900 px-4 font-bold text-white" onClick={() => void create()} data-testid="back-office-add-person">
          {copy.addPerson}
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
  const copy = useBackOfficeCopy();
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
    onSaved(copy.savedTarea(row.id));
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
            {copy.save}
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
  const copy = useBackOfficeCopy();
  const [board, setBoard] = useState<"caja" | "cocina">("caja");
  const [date, setDate] = useState("2026-09-20");
  const [hour, setHour] = useState(12);
  const [day, setDay] = useState<DayBoardDto|null>(null);
  const [shiftId, setShiftId] = useState("");
  const [stationId, setStationId] = useState("");

  const load = useCallback(async () => {
    try{const result=await fetchCompatibleBoard(board,date,auth["x-manager-session"]);
      if(!result.day){setDay(null);onError("DAY_UNAVAILABLE");return;}
      setDay(result.day);setShiftId(result.day.shifts[0]?.id??"");setStationId(result.day.stations[0]?.id??"");
    }catch{setDay(null);onError("DAY_UNAVAILABLE");}
  }, [board,date,onError,auth]);

  useEffect(() => {
    void load();
  }, [load]);

  async function seat() {
    if(day?.quarter){
      if(!day.quarterManagerId){onError("MANAGER_REQUIRED");return;}
      try{const result=await saveHourControl({managerId:day.quarterManagerId,board,date},day.quarter,[{shiftId,hour,action:{action:"station",stationId}}],auth["x-manager-session"]);
        if(result.status!=="saved"&&result.status!=="cleanup-pending"){onError(result.code??"SAVE_UNCONFIRMED_REVIEW_RETAINED_DRAFT");return;}
        onSaved(result.status==="saved"?copy.seated:"Saved; local cleanup pending.");await load();
      }catch(error){onError(error instanceof Error?error.message:"DRAFT_REQUIRES_REVIEW");}return;
    }

    const res = await fetch("/api/admin/seat-plan", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({ shiftId, stationId, date, hour }),
    });
    if (!res.ok) {
      onError(await readError(res));
      return;
    }
    onSaved(copy.seated);
    await load();
  }

  return (
    <section className="flex flex-col gap-3">
      <p className="text-sm text-neutral-700">
        {copy.seatsHelp}
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
          {copy.seat}
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
  const copy = useBackOfficeCopy();
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
    onSaved(copy.salesSaved);
    await load();
  }

  return (
    <section className="flex flex-col gap-3">
      <p className="text-sm text-neutral-700">
        {copy.salesHelp}
      </p>
      <div className="flex flex-wrap gap-2">
        <select className="min-h-11 rounded border-2 px-2" value={board} onChange={(e) => setBoard(e.target.value as "caja" | "cocina")}>
          <option value="caja">caja</option>
          <option value="cocina">cocina</option>
        </select>
        <select className="min-h-11 rounded border-2 px-2" value={dow} onChange={(e) => setDow(Number(e.target.value))} data-testid="sales-dow">
          {copy.weekdays.map((name, index) => (
            <option key={name} value={index}>{name}</option>
          ))}
        </select>
        <span className="self-center text-sm font-bold" data-testid="sales-sum">
          {copy.sum(sum.toFixed(1))}
        </span>
        <button type="button" className="min-h-11 rounded bg-neutral-900 px-4 font-bold text-white" onClick={() => void save()} data-testid="sales-save">
          {copy.savePercents}
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
  const copy = useBackOfficeCopy();
  const [rows, setRows] = useState<ManagerRow[]>([]);
  const [newName, setNewName] = useState("");
  const [newCode, setNewCode] = useState("");
  const [newLongIdle, setNewLongIdle] = useState(false);
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
      body: JSON.stringify({ name: newName, code: newCode, longIdle: newLongIdle }),
    });
    if (!res.ok) {
      onError(await readError(res));
      return;
    }
    setNewName("");
    setNewCode("");
    setNewLongIdle(false);
    await load();
  }

  async function updateManager(id: string, input: { code?: string; active?: boolean; role?: "owner" | "manager" }) {
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
        {copy.managersHelp}
      </p>
      <div className="flex flex-wrap gap-2 rounded border-2 border-neutral-300 p-3">
        <input
          className="min-h-11 rounded border-2 px-2"
          placeholder={copy.managerNamePh}
          value={newName}
          onChange={(event) => setNewName(event.target.value)}
          data-testid="manager-new-name"
        />
        <input
          className="min-h-11 rounded border-2 px-2"
          type="password"
          autoComplete="new-password"
          placeholder={copy.newCodePh}
          value={newCode}
          onChange={(event) => setNewCode(event.target.value)}
          data-testid="manager-new-code"
        />
        <label className="flex min-h-11 items-center gap-2 text-sm font-semibold">
          <input
            type="checkbox"
            className="h-5 w-5"
            checked={newLongIdle}
            onChange={(event) => setNewLongIdle(event.target.checked)}
            data-testid="manager-new-long-idle"
          />
          {copy.longIdle}
        </label>
        <button
          type="button"
          className="min-h-11 rounded bg-neutral-900 px-4 font-bold text-white"
          disabled={!newName.trim() || newCode.length < 4}
          onClick={() => void createManager()}
          data-testid="manager-create"
        >
          {copy.addManager}
        </button>
      </div>
      <ul className="flex flex-col gap-1" data-testid="manager-list">
        {rows.map((row) => (
          <li key={row.id} className="flex flex-wrap items-center gap-2 rounded border p-2" data-testid={`manager-${row.name}`}>
            <span className="font-semibold">
              {row.name} · {row.role === "owner" ? copy.owner : copy.manager} · {row.active ? copy.active : copy.inactive}
              {row.longIdle ? ` · ${copy.longUnlock}` : ""}
            </span>
            <input
              className="min-h-10 rounded border px-2"
              type="password"
              autoComplete="new-password"
              placeholder={copy.replacementCode}
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
              {copy.rotateCode}
            </button>
            <button
              type="button"
              className="min-h-10 rounded border-2 px-3 text-sm font-bold"
              onClick={() => void updateManager(row.id, { active: !row.active })}
              data-testid={`manager-active-${row.id}`}
            >
              {row.active ? copy.deactivate : copy.activate}
            </button>
            <button
              type="button"
              className="min-h-10 rounded border-2 px-3 text-sm font-bold"
              onClick={() =>
                void updateManager(row.id, { role: row.role === "owner" ? "manager" : "owner" })
              }
              data-testid={`manager-role-${row.id}`}
            >
              {row.role === "owner" ? copy.makeManager : copy.makeOwner}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function CambiosTab({
  auth,
  onError,
}: {
  auth: Record<string, string>;
  onError: (msg: string) => void;
}) {
  const copy = useBackOfficeCopy();
  const [date, setDate] = useState("");
  const [rows, setRows] = useState<ChangeRow[]>([]);

  const load = useCallback(async () => {
    const query = date ? `?date=${encodeURIComponent(date)}` : "";
    const res = await fetch(`/api/admin/changes${query}`, { headers: auth });
    if (!res.ok) {
      onError(await readError(res));
      setRows([]);
      return;
    }
    const data = (await res.json()) as { changes: ChangeRow[] };
    setRows(data.changes);
  }, [auth, date, onError]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="flex flex-col gap-3" data-testid="cambios-screen">
      <label className="flex max-w-xs flex-col gap-1 text-sm font-bold">
        {copy.day}
        <input
          type="date"
          className="min-h-11 rounded border-2 px-2"
          value={date}
          onChange={(event) => setDate(event.target.value)}
          data-testid="cambios-date"
        />
      </label>
      <ul className="flex flex-col gap-1" data-testid="cambios-list">
        {rows.map((row) => (
          <li key={row.id} className="rounded border p-2 text-sm" data-testid={`cambio-${row.kind}`}>
            <span className="font-semibold">{new Date(row.createdAt).toLocaleString()}</span>
            {" · "}
            <span data-testid="cambio-who">{row.who}</span>
            {" · "}
            <span>{row.what}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Planner G: the When I Work position -> station map Colocar fijos reads.
 * Every position string on a non-superseded shift, plus every saved key. A
 * string on "other", or spanning both boards, has no dropdown and is not
 * placed by fijos until its shifts settle onto one real board.
 */
function PositionsTab({
  auth,
  onError,
  onSaved,
}: {
  auth: Record<string, string>;
  onError: (msg: string) => void;
  onSaved: (msg: string) => void;
}) {
  const copy = useBackOfficeCopy();
  const [rows, setRows] = useState<PositionMapRow[]>([]);
  const [stations, setStations] = useState<StationOption[]>([]);

  const load = useCallback(async () => {
    const res = await fetch("/api/admin/position-map", { headers: auth });
    if (!res.ok) {
      onError(await readError(res));
      return;
    }
    const data = (await res.json()) as { rows: PositionMapRow[]; stations: StationOption[] };
    setRows(data.rows);
    setStations(data.stations);
  }, [auth, onError]);
  useEffect(() => {
    void load();
  }, [load]);

  async function save(position: string, stationId: string | null) {
    const res = await fetch("/api/admin/position-map", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({ position, stationId }),
    });
    if (!res.ok) {
      onError(await readError(res));
      return;
    }
    onSaved(copy.savedPosition(position));
    await load();
  }

  return (
    <section className="flex flex-col gap-2" data-testid="positions-tab">
      {rows.map((row) => {
        const options = stations.filter((s) => s.board === row.board);
        return (
          <div
            key={row.position}
            className="grid gap-2 rounded border-2 border-neutral-300 p-2 md:grid-cols-[1fr_10rem_auto]"
            data-testid={`position-row-${row.position}`}
          >
            <span className="font-semibold">
              {row.position}
              {!row.eligible && (
                <span className="ml-2 text-xs font-medium text-neutral-500">
                  {copy.notOneBoard}
                </span>
              )}
            </span>
            <select
              className="min-h-10 rounded border-2 px-2 disabled:opacity-50"
              value={row.stationId ?? ""}
              disabled={!row.eligible}
              data-testid={`position-select-${row.position}`}
              onChange={(e) =>
                setRows((prev) =>
                  prev.map((item) =>
                    item.position === row.position
                      ? { ...item, stationId: e.target.value || null }
                      : item,
                  ),
                )
              }
            >
              <option value="">{copy.none}</option>
              {options.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="min-h-10 rounded bg-neutral-900 px-3 font-bold text-white disabled:opacity-50"
              disabled={!row.eligible}
              onClick={() => void save(row.position, row.stationId)}
              data-testid={`position-save-${row.position}`}
            >
              {copy.save}
            </button>
          </div>
        );
      })}
    </section>
  );
}
