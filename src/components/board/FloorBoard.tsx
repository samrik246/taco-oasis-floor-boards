"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { hourGridHours, formatHourLabel } from "@/lib/hour-grid";
import { findBoardViolations } from "@/lib/violations";
import type { AbilityLevel } from "@/lib/rules/types";
import type { BoardKindUi, DayBoardDto, ShiftDto } from "./types";
import { stationColorClass } from "./board-helpers";
import {
  abilityFor,
  abilityBadgeClass,
  assignmentsAtStationHour,
  availableShiftsForHour,
  displayName,
  filterByAbilityLevel,
  sortShiftsByAbilityForStation,
} from "./board-helpers";
import { HoursLedgerPanel } from "./HoursLedgerPanel";
import { ManagerNotesPanel } from "./ManagerNotesPanel";
import { ViolationsBanner } from "./ViolationsBanner";
import {
  TrafficMetersPanel,
  type TrafficStateDto,
} from "./TrafficMetersPanel";
import {
  ReturnPromptBanner,
  type ReturnPromptDto,
} from "./ReturnPromptBanner";
import {
  TareasPanel,
  type SuggestionDto,
  type TareaAssignmentDto,
  type TareaTemplateDto,
} from "./TareasPanel";
import { MoveReasonModal, type PendingMove } from "./MoveReasonModal";
import { PerformanceSurveyPanel } from "./PerformanceSurveyPanel";
import { EmployeesPanel } from "./EmployeesPanel";
import { TimelinePanel } from "./TimelinePanel";
import { SchedulePanel } from "./SchedulePanel";
import { RushPanel } from "./RushPanel";
import { ManagerUnlockModal } from "./ManagerUnlockModal";
import {
  useManagerIdle,
  useManagerSession,
} from "./useManagerSession";
import type { MoveReason } from "@/lib/position-moves";
import { cn } from "@/lib/utils";
import { TRAFFIC_TICK_MS } from "@/lib/traffic/simulator";
import {
  boardDisplayName,
  displayStationLabel,
  localeForBoard,
  messagesFor,
} from "@/lib/i18n";
import { managerAuthHeaders } from "@/lib/managers/auth-headers";
import { readLastBoard, saveLastBoard } from "@/lib/offline-board";
import { rushLeadNotice, type RushForecast } from "@/lib/rush/forecast";
import { KioskLock, kioskRequested } from "./KioskLock";

type Toast = { kind: "ok" | "err"; text: string } | null;
type MainView = "board" | "timeline" | "schedule" | "tareas" | "rush";

function playReturnChime() {
  try {
    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = 880;
    gain.gain.value = 0.08;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.18);
    window.setTimeout(() => void ctx.close(), 300);
  } catch {
    /* ignore audio failures */
  }
}

/**
 * Floor board UI — Android tablet Chrome first (landscape ~1280×800+).
 * Bilingual by board (caja EN / cocina ES), timeline matrix, staff vs manager.
 */
export function FloorBoard() {
  const searchParams = useSearchParams();
  const readonly =
    searchParams.get("readonly") === "1" ||
    searchParams.get("readonly") === "true";
  const kiosk = kioskRequested(searchParams);

  const [board, setBoard] = useState<BoardKindUi>("caja");
  const [mainView, setMainView] = useState<MainView>("board");
  const [unlockOpen, setUnlockOpen] = useState(false);
  const { manager, isManager, idleMs, unlock, lock } = useManagerSession();

  const locale = localeForBoard(board);
  const t = messagesFor(locale);

  const [dates, setDates] = useState<string[]>([]);
  const [date, setDate] = useState<string>("");
  const [hour, setHour] = useState<number>(10);
  const [day, setDay] = useState<DayBoardDto | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const [rushForecast, setRushForecast] = useState<RushForecast | null>(null);
  const [toast, setToast] = useState<Toast>(null);
  const [selectedStationId, setSelectedStationId] = useState<string | null>(
    null,
  );
  const [selectedShiftId, setSelectedShiftId] = useState<string | null>(null);
  const [ledgerEmployeeId, setLedgerEmployeeId] = useState<string | null>(null);
  const [ledgerEmployeeName, setLedgerEmployeeName] = useState<string | null>(
    null,
  );
  const [ledgerRefreshKey, setLedgerRefreshKey] = useState(0);
  const [swapFirstId, setSwapFirstId] = useState<string | null>(null);
  const [abilityFilter, setAbilityFilter] = useState<AbilityLevel | "all">(
    "all",
  );
  const [clock, setClock] = useState<string>("");

  const [traffic, setTraffic] = useState<TrafficStateDto | null>(null);
  const [returnPrompts, setReturnPrompts] = useState<ReturnPromptDto[]>([]);
  const [chimeMute, setChimeMute] = useState(false);
  const [tareaTemplates, setTareaTemplates] = useState<TareaTemplateDto[]>([]);
  const [tareaAssignments, setTareaAssignments] = useState<
    TareaAssignmentDto[]
  >([]);
  const [selectedTareaTemplateId, setSelectedTareaTemplateId] = useState<
    string | null
  >(null);
  const [suggestions, setSuggestions] = useState<SuggestionDto[]>([]);
  const [pendingMove, setPendingMove] = useState<PendingMove | null>(null);
  const [isLargeUi, setIsLargeUi] = useState(true);
  const knownPromptIds = useRef<Set<string>>(new Set());
  const toastTimerRef = useRef<number | null>(null);

  const showToast = useCallback((kind: "ok" | "err", text: string) => {
    setToast({ kind, text });
    if (toastTimerRef.current != null) {
      window.clearTimeout(toastTimerRef.current);
    }
    toastTimerRef.current = window.setTimeout(() => {
      setToast(null);
      toastTimerRef.current = null;
    }, 4000);
  }, []);

  useManagerIdle({
    active: isManager && !readonly,
    idleMs,
    onIdle: () => {
      lock();
      setUnlockOpen(false);
      setPendingMove(null);
      showToast("ok", t.managerIdleLogout);
    },
  });

  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1280px)");
    const apply = () => setIsLargeUi(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  useEffect(() => {
    const tick = () => {
      const next = new Date();
      setNow(next);
      setClock(
        new Date().toLocaleTimeString(locale === "es" ? "es-MX" : "en-US", {
          timeZone: "America/Chicago",
          hour: "numeric",
          minute: "2-digit",
        }),
      );
    };
    tick();
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, [locale]);

  const bumpLedger = useCallback(() => {
    setLedgerRefreshKey((k) => k + 1);
  }, []);

  const refreshDates = useCallback(async () => {
    try {
      const res = await fetch("/api/days");
      if (!res.ok) {
        setLoadError("Could not load available dates.");
        return;
      }
      const data = (await res.json()) as { dates: string[] };
      setDates(data.dates);
      setLoadError(null);
      setDate((prev) => {
        if (prev && data.dates.includes(prev)) return prev;
        if (data.dates.includes("2026-09-20")) return "2026-09-20";
        return data.dates[0] ?? "";
      });
    } catch {
      setLoadError("Network error loading dates.");
    }
  }, []);

  const refreshBoard = useCallback(async () => {
    if (!date) {
      setDay(null);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`/api/boards/${board}/days/${date}`);
      if (!res.ok) throw new Error("load");
      const data = (await res.json()) as DayBoardDto;
      setDay(data);
      setLoadError(null);
      setOffline(false);
      saveLastBoard({ board, date, day: data });
    } catch {
      const cached = readLastBoard();
      if (cached?.day) {
        const snapshot = cached.day as DayBoardDto;
        setDay(snapshot);
        setDate(cached.date);
        setBoard(cached.board);
        setOffline(true);
        setLoadError(null);
      } else {
        setLoadError(t.toastNetwork);
        showToast("err", t.toastNetwork);
      }
    } finally {
      setLoading(false);
    }
  }, [board, date, showToast, t]);

  const refreshTraffic = useCallback(async () => {
    if (!date) return;
    try {
      const res = await fetch(
        `/api/traffic?date=${encodeURIComponent(date)}&hour=${hour}&board=${board}`,
      );
      if (!res.ok) return;
      const data = (await res.json()) as TrafficStateDto;
      setTraffic(data);
    } catch {
      /* soft fail */
    }
  }, [date, hour, board]);

  const refreshReturnPrompts = useCallback(async () => {
    if (!date) return;
    try {
      const res = await fetch(
        `/api/return-prompts?date=${encodeURIComponent(date)}`,
      );
      if (!res.ok) return;
      const data = (await res.json()) as { prompts: ReturnPromptDto[] };
      const next = data.prompts ?? [];
      const fresh = next.filter((p) => !knownPromptIds.current.has(p.id));
      if (fresh.length > 0 && !chimeMute) {
        playReturnChime();
      }
      for (const p of next) knownPromptIds.current.add(p.id);
      setReturnPrompts(next);
    } catch {
      /* soft fail */
    }
  }, [date, chimeMute]);

  const refreshTareas = useCallback(async () => {
    if (!date) return;
    try {
      const res = await fetch(
        `/api/tareas?date=${encodeURIComponent(date)}&board=${board}`,
      );
      if (!res.ok) return;
      const data = (await res.json()) as {
        templates: TareaTemplateDto[];
        assignments: TareaAssignmentDto[];
      };
      setTareaTemplates(data.templates ?? []);
      setTareaAssignments(data.assignments ?? []);
    } catch {
      /* soft fail */
    }
  }, [date, board]);

  const refreshSuggestions = useCallback(async () => {
    if (!date || !selectedTareaTemplateId) {
      setSuggestions([]);
      return;
    }
    try {
      const res = await fetch(
        `/api/tareas?date=${encodeURIComponent(date)}&hour=${hour}&board=${board}&suggest=${encodeURIComponent(selectedTareaTemplateId)}`,
      );
      if (!res.ok) return;
      const data = (await res.json()) as { suggestions: SuggestionDto[] };
      setSuggestions(data.suggestions ?? []);
    } catch {
      /* soft fail */
    }
  }, [date, hour, selectedTareaTemplateId, board]);

  const refreshPhase1 = useCallback(async () => {
    await Promise.all([
      refreshBoard(),
      refreshTraffic(),
      refreshReturnPrompts(),
      refreshTareas(),
      refreshSuggestions(),
    ]);
  }, [
    refreshBoard,
    refreshTraffic,
    refreshReturnPrompts,
    refreshTareas,
    refreshSuggestions,
  ]);

  useEffect(() => {
    void refreshDates();
  }, [refreshDates]);

  useEffect(() => {
    void refreshBoard();
  }, [refreshBoard]);

  useEffect(() => {
    void refreshTraffic();
    void refreshReturnPrompts();
    void refreshTareas();
    setSelectedTareaTemplateId(null);
  }, [board, refreshTraffic, refreshReturnPrompts, refreshTareas]);

  useEffect(() => {
    void refreshSuggestions();
  }, [refreshSuggestions]);

  useEffect(() => {
    const id = window.setInterval(() => {
      void refreshPhase1();
    }, TRAFFIC_TICK_MS);
    return () => window.clearInterval(id);
  }, [refreshPhase1]);

  const available = useMemo(() => {
    if (!day || !date) return [];
    let list = availableShiftsForHour(day.shifts, date, hour);
    if (selectedStationId) {
      list = sortShiftsByAbilityForStation(list, selectedStationId);
      list = filterByAbilityLevel(list, selectedStationId, abilityFilter);
      if (abilityFilter !== "forbidden") {
        list = list.filter(
          (sh) => abilityFor(sh, selectedStationId) !== "forbidden",
        );
      }
    }
    return list;
  }, [day, date, hour, selectedStationId, abilityFilter]);

  const violations = useMemo(
    () => (day ? findBoardViolations(day) : []),
    [day],
  );

  function selectLedgerEmployee(shift: ShiftDto) {
    setLedgerEmployeeId(shift.employee.id);
    setLedgerEmployeeName(displayName(shift));
  }

  async function loadSample() {
    if (readonly || offline) {
      showToast("err", offline ? t.offlineBanner : t.toastReadonly);
      return;
    }
    if (!isManager || !manager?.token) {
      setUnlockOpen(true);
      showToast("err", t.managerOnly);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/sample", {
        headers: managerAuthHeaders(manager.token),
      });
      const data = await res.json();
      if (!res.ok) {
        showToast("err", data.error ?? t.toastSampleFailed);
        return;
      }
      showToast("ok", t.toastSample(data.rowCount));
      await refreshDates();
      await refreshPhase1();
      bumpLedger();
    } finally {
      setLoading(false);
    }
  }

  async function onUpload(file: File | null) {
    if (readonly || offline) {
      showToast("err", offline ? t.offlineBanner : t.toastReadonly);
      return;
    }
    if (!isManager || !manager?.token) {
      setUnlockOpen(true);
      showToast("err", t.managerOnly);
      return;
    }
    if (!file) return;
    setLoading(true);
    try {
      const form = new FormData();
      form.set("file", file);
      const res = await fetch("/api/imports", {
        method: "POST",
        headers: managerAuthHeaders(manager.token),
        body: form,
      });
      const data = await res.json();
      if (!res.ok) {
        showToast("err", data.error ?? t.toastUploadFailed);
        return;
      }
      showToast("ok", t.toastImported(data.rowCount));
      await refreshDates();
      await refreshPhase1();
      bumpLedger();
    } finally {
      setLoading(false);
    }
  }

  async function assign(shiftId: string, stationId: string) {
    if (readonly || offline) {
      showToast("err", offline ? t.offlineBanner : t.toastReadonly);
      return;
    }
    const res = await fetch("/api/assignments", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ shiftId, stationId, date, hour }),
    });
    const data = await res.json();
    if (!res.ok) {
      const codes = (data.violations ?? [])
        .map((v: { code: string }) => v.code)
        .join(", ");
      showToast("err", codes || data.error || t.toastAssignRejected);
      return;
    }
    showToast("ok", t.toastAssigned);
    setSelectedShiftId(null);
    const shift = day?.shifts.find((s) => s.id === shiftId);
    if (shift) selectLedgerEmployee(shift);
    await refreshBoard();
    bumpLedger();
  }

  function requestClear(
    assignmentId: string,
    shift: ShiftDto,
    stationId: string,
  ) {
    if (readonly || offline) {
      showToast("err", offline ? t.offlineBanner : t.toastReadonly);
      return;
    }
    if (!isManager) {
      setUnlockOpen(true);
      showToast("err", t.unlockManager);
      return;
    }
    setPendingMove({
      assignmentId,
      employeeId: shift.employee.id,
      employeeName: displayName(shift),
      fromStationId: stationId,
    });
  }

  async function confirmClear(reason: MoveReason, note: string) {
    if (!pendingMove) return;
    const moveRes = await fetch("/api/position-moves", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...managerAuthHeaders(manager?.token),
      },
      body: JSON.stringify({
        date,
        hour,
        employeeId: pendingMove.employeeId,
        fromStationId: pendingMove.fromStationId,
        toStationId: null,
        assignmentId: pendingMove.assignmentId,
        reason,
        note: note || null,
      }),
    });
    if (!moveRes.ok) {
      const data = await moveRes.json();
      showToast("err", data.error ?? t.toastMoveFailed);
      return;
    }

    const res = await fetch(`/api/assignments/${pendingMove.assignmentId}`, {
      method: "DELETE",
      headers: managerAuthHeaders(manager?.token),
    });
    const data = await res.json();
    setPendingMove(null);
    if (!res.ok) {
      showToast("err", data.error ?? t.toastClearFailed);
      return;
    }
    showToast("ok", t.toastCleared);
    setSwapFirstId(null);
    await refreshBoard();
    bumpLedger();
  }

  async function onSwapSelect(assignmentId: string) {
    if (readonly || offline) {
      showToast("err", offline ? t.offlineBanner : t.toastReadonly);
      return;
    }
    if (!swapFirstId) {
      setSwapFirstId(assignmentId);
      showToast("ok", t.toastSwapPick);
      return;
    }
    if (swapFirstId === assignmentId) {
      setSwapFirstId(null);
      return;
    }
    const res = await fetch("/api/assignments/swap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        assignmentIdA: swapFirstId,
        assignmentIdB: assignmentId,
      }),
    });
    const data = await res.json();
    setSwapFirstId(null);
    if (!res.ok) {
      const codes = (data.violations ?? [])
        .map((v: { code: string }) => v.code)
        .join(", ");
      showToast("err", codes || data.error || t.toastSwapRejected);
      return;
    }
    showToast("ok", t.toastSwapped);
    await refreshBoard();
    bumpLedger();
  }

  function onStationTap(stationId: string) {
    setSelectedStationId(stationId);
    if (readonly || offline) return;
    if (selectedShiftId) {
      void assign(selectedShiftId, stationId);
    }
  }

  function onPersonTap(shift: ShiftDto) {
    selectLedgerEmployee(shift);
    if (readonly || offline) {
      setSelectedShiftId(shift.id);
      return;
    }
    if (selectedStationId) {
      const level = abilityFor(shift, selectedStationId);
      if (level === "forbidden") {
        showToast("err", t.toastForbidden);
        return;
      }
      void assign(shift.id, selectedStationId);
      return;
    }
    setSelectedShiftId((prev) => (prev === shift.id ? null : shift.id));
  }

  async function toggleTraffic(enabled: boolean) {
    if (readonly || offline) return;
    if (!isManager || !manager?.token) {
      setUnlockOpen(true);
      showToast("err", t.managerOnly);
      return;
    }
    setTraffic((prev) =>
      prev
        ? { ...prev, enabled }
        : { enabled, lastTickAt: null, meters: [] },
    );
    const res = await fetch("/api/traffic", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        ...managerAuthHeaders(manager.token),
      },
      body: JSON.stringify({ enabled, date, hour, board }),
    });
    if (!res.ok) {
      setTraffic((prev) => (prev ? { ...prev, enabled: !enabled } : prev));
      showToast("err", t.toastSimToggleFailed);
      return;
    }
    const data = (await res.json()) as TrafficStateDto;
    setTraffic(data);
    await refreshReturnPrompts();
    await refreshTareas();
    showToast("ok", enabled ? t.toastSimulatorOn : t.toastSimulatorOff);
  }

  async function ackReturnPrompt(id: string) {
    const res = await fetch("/api/return-prompts", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    if (!res.ok) {
      showToast("err", t.toastAckFailed);
      return;
    }
    await refreshReturnPrompts();
  }

  async function assignTarea(employeeId: string, forceLemon: boolean) {
    if (readonly || offline || !selectedTareaTemplateId) return;
    const res = await fetch("/api/tareas", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        date,
        employeeId,
        templateId: selectedTareaTemplateId,
        hour,
        forceLemon,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      if (data.code === "LEMON_WARN_GREENS") {
        showToast("err", data.lemonWarning ?? data.error);
        return;
      }
      showToast("err", data.error ?? t.toastTareaFailed);
      return;
    }
    if (data.lemonWarning) showToast("ok", data.lemonWarning);
    else showToast("ok", t.toastTareaAssigned);
    await refreshTareas();
    await refreshSuggestions();
  }

  async function setTareaStatus(id: string, status: "working" | "done") {
    if (readonly || offline) return;
    const res = await fetch("/api/tareas", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, status }),
    });
    if (!res.ok) {
      showToast("err", t.toastTareaUpdateFailed);
      return;
    }
    await refreshTareas();
  }

  useEffect(() => {
    if (!date) {
      setRushForecast(null);
      return;
    }
    let cancel = false;
    void (async () => {
      try {
        const res = await fetch(
          `/api/rush?board=${board}&date=${encodeURIComponent(date)}`,
        );
        if (!res.ok) return;
        const data = (await res.json()) as { forecast: RushForecast };
        if (!cancel) setRushForecast(data.forecast);
      } catch {
        if (!cancel) setRushForecast(null);
      }
    })();
    return () => {
      cancel = true;
    };
  }, [board, date]);

  const hours = hourGridHours();
  const hasStations = (day?.stations.length ?? 0) > 0;
  const emptyBoard = Boolean(date && day && day.shifts.length === 0);
  const showBoardExtras = board === "caja" || board === "cocina";
  const boardName = boardDisplayName(locale, board);
  const editsLocked = readonly || offline;
  const canMutateStaff = !editsLocked;
  const showManagerPanels = isManager && !editsLocked;
  const leadNotice =
    isManager && !offline && rushForecast && date
      ? rushLeadNotice({
          forecast: rushForecast,
          now,
          dateYmd: date,
          locale,
        })
      : null;

  const tareasPanel = (
    <TareasPanel
      templates={tareaTemplates}
      assignments={tareaAssignments}
      suggestions={suggestions}
      selectedTemplateId={selectedTareaTemplateId}
      onSelectTemplate={setSelectedTareaTemplateId}
      onAssign={(id, force) => void assignTarea(id, force)}
      onMarkDone={(id) => void setTareaStatus(id, "done")}
      onMarkWorking={(id) => void setTareaStatus(id, "working")}
      readonly={editsLocked}
      compact={!isLargeUi}
      locale={locale}
      t={t}
    />
  );

  return (
    <div
      className="flex min-h-dvh flex-col bg-neutral-50 text-neutral-950"
      data-readonly={readonly ? "1" : "0"}
      data-offline={offline ? "1" : "0"}
      data-large-ui={isLargeUi ? "1" : "0"}
      data-locale={locale}
      data-role={isManager ? "manager" : "staff"}
      data-main-view={mainView}
      data-testid="floor-board"
    >
      <KioskLock active={kiosk} />
      <header className="sticky top-0 z-20 border-b-2 border-neutral-900 bg-white px-3 py-3 sm:px-4">
        <div className="flex flex-wrap items-center gap-2 sm:gap-3">
          <h1 className="text-xl font-bold tracking-tight md:text-2xl">
            {t.brand}
          </h1>

          {readonly && (
            <span
              className="rounded-md border-2 border-amber-800 bg-amber-100 px-3 py-1 text-sm font-bold text-amber-950"
              data-testid="readonly-badge"
            >
              {t.readonly}
            </span>
          )}
          {offline && (
            <span
              className="rounded-md border-2 border-amber-800 bg-amber-100 px-3 py-1 text-sm font-bold text-amber-950"
              data-testid="offline-badge"
            >
              {t.offlineBadge}
            </span>
          )}

          <span
            className="rounded-md border border-neutral-400 px-2 py-1 text-xs font-semibold text-neutral-700"
            data-testid="ui-size-badge"
          >
            {isLargeUi ? t.largeTablet : t.compactTablet}
          </span>

          <span
            className={cn(
              "rounded-md border-2 px-2 py-1 text-xs font-bold",
              isManager
                ? "border-emerald-900 bg-emerald-100 text-emerald-950"
                : "border-neutral-500 bg-neutral-100 text-neutral-800",
            )}
            data-testid="role-badge"
          >
            {isManager
              ? t.managerUnlocked(manager?.name ?? t.managerView)
              : t.staffView}
          </span>

          <div
            className="inline-flex rounded-lg border-2 border-neutral-900 p-1"
            role="group"
            aria-label="Board"
          >
            {(["caja", "cocina"] as const).map((b) => (
              <button
                key={b}
                type="button"
                className={cn(
                  "touch-target min-h-11 min-w-[7rem] rounded-md px-4 text-base font-semibold active:opacity-90",
                  board === b
                    ? "bg-neutral-900 text-white"
                    : "bg-white text-neutral-900 active:bg-neutral-200",
                )}
                onClick={() => {
                  setBoard(b);
                  setSelectedStationId(null);
                  setSelectedShiftId(null);
                  setSwapFirstId(null);
                }}
                data-testid={`board-toggle-${b}`}
              >
                {b === "caja" ? t.cashiers : t.kitchen}
              </button>
            ))}
          </div>

          <div
            className="inline-flex rounded-lg border-2 border-neutral-700 p-1"
            role="group"
            aria-label="Main view"
            data-testid="main-view-toggle"
          >
            {(
              [
                ["board", t.viewBoard],
                ["timeline", t.viewTimeline],
                ["schedule", t.viewSchedule],
                ["tareas", t.viewTareas],
                ["rush", t.viewRush],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                className={cn(
                  "touch-target min-h-11 rounded-md px-3 text-sm font-semibold active:opacity-90",
                  mainView === id
                    ? "bg-neutral-800 text-white"
                    : "bg-white text-neutral-900 active:bg-neutral-200",
                )}
                onClick={() => setMainView(id)}
                data-testid={`view-toggle-${id}`}
              >
                {label}
              </button>
            ))}
          </div>

          {!readonly && (
            <Button
              type="button"
              variant="outline"
              size="lg"
              className="min-h-11 border-2"
              onClick={() => {
                if (isManager) {
                  lock();
                  showToast("ok", t.staffView);
                } else {
                  setUnlockOpen(true);
                }
              }}
              data-testid={isManager ? "exit-manager" : "enter-manager"}
            >
              {isManager ? t.exitManager : t.unlockManager}
            </Button>
          )}

          <label className="flex min-h-11 items-center gap-2 text-sm font-semibold">
            {t.date}
            <select
              className="touch-target min-h-11 min-w-[10rem] rounded-md border-2 border-neutral-900 bg-white px-3 text-base font-medium"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              data-testid="date-select"
            >
              {dates.length === 0 && <option value="">{t.noDates}</option>}
              {dates.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </label>

          <a
            href={`/?wall=1&board=${board}`}
            className="text-sm font-bold underline"
            data-testid="open-wall"
          >
            {t.wallTitle}
          </a>
          <a
            href="/back-office"
            className="text-sm font-bold underline"
            data-testid="open-back-office"
          >
            Back office
          </a>

          <span
            className="text-base font-semibold tabular-nums sm:ml-auto sm:text-lg"
            title="America/Chicago"
            aria-live="polite"
          >
            {clock} CT
          </span>

          <Button
            type="button"
            size="lg"
            className="min-h-11 border-2 border-neutral-900"
            onClick={() => void loadSample()}
            disabled={loading || editsLocked || !isManager}
            title={!isManager ? t.managerOnly : undefined}
            data-testid="load-sample"
          >
            {t.loadSample}
          </Button>

          <label
            className={cn(
              "inline-flex min-h-11 items-center rounded-md border-2 border-neutral-900 bg-white px-4 text-sm font-semibold",
              editsLocked || !isManager
                ? "cursor-not-allowed opacity-50"
                : "cursor-pointer active:bg-neutral-200",
            )}
          >
            {t.upload}
            <input
              type="file"
              accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
              className="sr-only"
              disabled={editsLocked || !isManager}
              onChange={(e) => {
                void onUpload(e.target.files?.[0] ?? null);
                e.target.value = "";
              }}
            />
          </label>

          <Button
            type="button"
            variant="outline"
            size="lg"
            className="min-h-11 border-2"
            disabled
            title="Auto-fill coming later (NoOp stub)"
          >
            {t.autofillSoon}
          </Button>
        </div>

        <div className="mt-3 flex items-center gap-2 overflow-x-auto pb-1">
          <span className="shrink-0 text-sm font-bold">{t.hour}</span>
          {hours.map((h) => (
            <button
              key={h}
              type="button"
              className={cn(
                "touch-target min-h-11 shrink-0 rounded-md border-2 px-3 text-sm font-semibold active:opacity-90",
                hour === h
                  ? "border-neutral-900 bg-neutral-900 text-white"
                  : "border-neutral-500 bg-white active:bg-neutral-200",
              )}
              onClick={() => setHour(h)}
              data-testid={`hour-${h}`}
            >
              {formatHourLabel(h)}
            </button>
          ))}
        </div>
      </header>

      {offline && (
        <p
          className="border-b-2 border-amber-800 bg-amber-100 px-4 py-2 text-sm font-bold text-amber-950"
          data-testid="offline-banner"
          role="status"
        >
          {t.offlineBanner}
        </p>
      )}
      {leadNotice && (
        <p
          className="border-b-2 border-orange-700 bg-orange-200 px-4 py-2 text-base font-black text-orange-950"
          data-testid="rush-lead-banner"
          role="status"
        >
          {leadNotice.text}
        </p>
      )}

      {toast && (
        <div
          className={cn(
            "mx-3 mt-3 rounded-md border-2 px-4 py-3 text-base font-semibold sm:mx-4",
            toast.kind === "ok"
              ? "border-emerald-900 bg-emerald-100 text-emerald-950"
              : "border-red-900 bg-red-100 text-red-950",
          )}
          role="status"
          data-testid="toast"
        >
          {toast.text}
        </div>
      )}

      {loadError && (
        <div
          className="mx-3 mt-3 rounded-md border-2 border-red-900 bg-red-50 px-4 py-3 text-base font-semibold text-red-950 sm:mx-4"
          role="alert"
          data-testid="load-error"
        >
          {loadError}
        </div>
      )}

      {showBoardExtras && (
        <ReturnPromptBanner
          prompts={returnPrompts}
          mute={chimeMute}
          onMuteChange={setChimeMute}
          onAck={(id) => void ackReturnPrompt(id)}
          readonly={editsLocked}
          locale={locale}
          t={t}
        />
      )}

      <ViolationsBanner violations={violations} t={t} />

      {showBoardExtras && mainView !== "tareas" && (
        <div className="px-3 pt-3 sm:px-4">
          <TrafficMetersPanel
            traffic={traffic}
            readonly={editsLocked}
            canToggle={isManager && !editsLocked}
            onToggle={(en) => void toggleTraffic(en)}
            compact={!isLargeUi}
            locale={locale}
            t={t}
          />
        </div>
      )}

      {mainView === "timeline" && (
        <div className="p-3 sm:p-4">
          <TimelinePanel
            day={day}
            date={date}
            locale={locale}
            t={t}
            selectedHour={hour}
            onSelectHour={setHour}
            managerMode={isManager}
          />
        </div>
      )}

      {mainView === "schedule" && (
        <div className="p-3 sm:p-4">
          <SchedulePanel day={day} date={date} locale={locale} t={t} />
        </div>
      )}

      {mainView === "rush" && (
        <div className="p-3 sm:p-4">
          <RushPanel
            day={day}
            date={date}
            board={board}
            locale={locale}
            t={t}
          />
        </div>
      )}

      {mainView === "tareas" && showBoardExtras && (
        <div className="grid gap-3 p-3 sm:p-4 xl:grid-cols-[1fr_20rem]">
          {tareasPanel}
          {showManagerPanels && (
            <div className="flex flex-col gap-3">
              <HoursLedgerPanel
                employeeId={ledgerEmployeeId}
                employeeName={ledgerEmployeeName}
                weekOf={date}
                refreshKey={ledgerRefreshKey}
                locale={locale}
                t={t}
              />
              <PerformanceSurveyPanel
                date={date}
                board={board}
                employeeId={ledgerEmployeeId}
                employeeName={ledgerEmployeeName}
                readonly={editsLocked}
                locale={locale}
                t={t}
                managerToken={manager?.token ?? null}
              />
            </div>
          )}
        </div>
      )}

      {mainView === "board" && (
        <div className="grid flex-1 gap-3 p-3 sm:gap-4 sm:p-4 xl:grid-cols-[16rem_minmax(0,1fr)_18rem]">
          <aside className="flex flex-col gap-3 rounded-lg border-2 border-neutral-900 bg-white p-3">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-lg font-bold">{t.available}</h2>
              <span className="text-sm font-semibold text-neutral-700">
                {formatHourLabel(hour)}
              </span>
            </div>

            <label className="flex flex-col gap-1 text-xs font-bold uppercase tracking-wide text-neutral-700">
              {t.abilityFilter}
              <select
                className="touch-target min-h-11 rounded-md border-2 border-neutral-800 bg-white px-2 text-sm font-semibold normal-case text-neutral-900"
                value={abilityFilter}
                onChange={(e) =>
                  setAbilityFilter(e.target.value as AbilityLevel | "all")
                }
                disabled={!selectedStationId}
              >
                <option value="all">{t.abilityAll}</option>
                <option value="preferred">preferred</option>
                <option value="ok">ok</option>
                <option value="training">training</option>
                <option value="forbidden">forbidden</option>
              </select>
            </label>

            {!selectedStationId && canMutateStaff && (
              <p className="text-sm font-medium text-neutral-700">{t.tapHint}</p>
            )}
            {readonly && (
              <p className="text-sm font-medium text-neutral-700">
                {t.readonlyHint}
              </p>
            )}

            <ul
              className="flex max-h-[40vh] flex-col gap-2 overflow-y-auto xl:max-h-[55vh]"
              data-testid="available-list"
            >
              {available.length === 0 && (
                <li className="rounded-md border-2 border-dashed border-neutral-400 px-3 py-4 text-sm font-medium text-neutral-600">
                  {date ? t.noOneAvailable : t.loadOrUpload}
                </li>
              )}
              {available.map((sh) => {
                const level = selectedStationId
                  ? abilityFor(sh, selectedStationId)
                  : null;
                const selected = selectedShiftId === sh.id;
                return (
                  <li key={sh.id}>
                    <button
                      type="button"
                      onClick={() => onPersonTap(sh)}
                      data-testid={`available-${sh.employee.externalId}`}
                      className={cn(
                        "flex w-full min-h-14 flex-col items-start rounded-md border-2 px-3 py-2 text-left active:opacity-90",
                        selected
                          ? "border-neutral-900 bg-neutral-900 text-white"
                          : "border-neutral-500 bg-neutral-50 active:bg-neutral-200",
                      )}
                    >
                      <span className="text-base font-bold">
                        {displayName(sh)}
                      </span>
                      <span
                        className={cn(
                          "text-xs font-medium",
                          selected ? "text-neutral-300" : "text-neutral-700",
                        )}
                      >
                        {sh.sourcePosition}
                      </span>
                      {level && (
                        <span
                          className={cn(
                            "mt-1 rounded px-1.5 py-0.5 text-[10px] font-bold uppercase",
                            abilityBadgeClass(level),
                          )}
                        >
                          {level}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </aside>

          <section className="flex min-w-0 flex-col gap-3">
            <div className="flex flex-wrap items-end justify-between gap-2">
              <h2 className="text-lg font-bold">
                {t.stationsHeading(boardName, date)}
              </h2>
              {swapFirstId && !readonly && (
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11 border-2 border-amber-800"
                  onClick={() => setSwapFirstId(null)}
                >
                  {t.cancelSwap}
                </Button>
              )}
            </div>

            {loading && !day && (
              <p className="font-medium text-neutral-700">{t.loading}</p>
            )}

            {emptyBoard && (
              <p
                className="rounded-lg border-2 border-dashed border-neutral-500 p-6 text-center font-medium text-neutral-700"
                data-testid="empty-shifts"
              >
                {t.emptyShifts(date)}
              </p>
            )}

            <div
              className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4"
              data-testid="station-grid"
            >
              {(day?.stations ?? []).map((station) => {
                const occupied = day
                  ? assignmentsAtStationHour(
                      day.shifts,
                      station.id,
                      date,
                      hour,
                    )
                  : [];
                const selected = selectedStationId === station.id;
                const full =
                  station.maxConcurrent >= 0 &&
                  occupied.length >= station.maxConcurrent;
                const label = displayStationLabel(locale, station);

                return (
                  <div
                    key={station.id}
                    data-testid={`station-${station.id}`}
                    className={cn(
                      "flex min-h-40 flex-col rounded-lg border-4 p-3",
                      stationColorClass(station.color),
                      selected && "ring-4 ring-neutral-900 ring-offset-2",
                    )}
                  >
                    <button
                      type="button"
                      className="mb-2 min-h-11 w-full text-left active:opacity-80"
                      onClick={() => onStationTap(station.id)}
                      disabled={
                        readonly && occupied.length > 0 && !selectedShiftId
                      }
                    >
                      <div className="text-lg font-extrabold leading-tight">
                        {label}
                      </div>
                      <div className="text-xs font-bold opacity-90">
                        {t.maxLabel(station.maxConcurrent)}
                        {full ? ` · ${t.full}` : ""}
                      </div>
                    </button>

                    <div className="mt-auto flex flex-col gap-2">
                      {occupied.length === 0 && (
                        <button
                          type="button"
                          className="min-h-12 rounded border-2 border-dashed border-current/50 text-sm font-bold active:bg-black/5 disabled:opacity-50"
                          onClick={() => onStationTap(station.id)}
                          disabled={readonly}
                        >
                          {readonly ? t.empty : t.tapToAssign}
                        </button>
                      )}
                      {occupied.map(({ shift, assignment }) => (
                        <div
                          key={assignment.id}
                          className={cn(
                            "flex min-h-12 items-center justify-between gap-2 rounded-md border-2 border-neutral-900 bg-white px-2 py-1",
                            swapFirstId === assignment.id &&
                              "ring-2 ring-amber-700",
                          )}
                        >
                          <button
                            type="button"
                            className="min-h-11 flex-1 text-left text-sm font-bold active:bg-neutral-100"
                            onClick={() => {
                              selectLedgerEmployee(shift);
                              if (!readonly) void onSwapSelect(assignment.id);
                            }}
                            aria-label={displayName(shift)}
                            data-testid={`assignee-${station.id}`}
                          >
                            {displayName(shift)}
                          </button>
                          {!readonly && (
                            <button
                              type="button"
                              className="touch-target min-h-11 min-w-11 rounded bg-neutral-900 text-sm font-bold text-white active:bg-neutral-700"
                              onClick={() =>
                                requestClear(
                                  assignment.id,
                                  shift,
                                  station.id,
                                )
                              }
                              aria-label={`Clear ${displayName(shift)}`}
                              data-testid={`clear-${station.id}`}
                            >
                              ✕
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>

            {!day && date === "" && !loading && (
              <p
                className="rounded-lg border-2 border-dashed border-neutral-500 p-8 text-center font-medium text-neutral-700"
                data-testid="empty-state"
              >
                {t.emptyState}
              </p>
            )}

            {date && day && !hasStations && (
              <p className="rounded-lg border-2 border-dashed border-neutral-500 p-6 text-center font-medium text-neutral-700">
                {t.noStationsSeeded}
              </p>
            )}

            {showBoardExtras && !isLargeUi && tareasPanel}
          </section>

          <div className="flex flex-col gap-3">
            {showBoardExtras && isLargeUi && tareasPanel}
            {showManagerPanels && (
              <>
                <HoursLedgerPanel
                  employeeId={ledgerEmployeeId}
                  employeeName={ledgerEmployeeName}
                  weekOf={date}
                  refreshKey={ledgerRefreshKey}
                  locale={locale}
                  t={t}
                />
                <PerformanceSurveyPanel
                  date={date}
                  board={board}
                  employeeId={ledgerEmployeeId}
                  employeeName={ledgerEmployeeName}
                  readonly={editsLocked}
                  locale={locale}
                  t={t}
                  managerToken={manager?.token ?? null}
                />
                <EmployeesPanel
                  readonly={editsLocked}
                  board={board}
                  authHeaders={managerAuthHeaders(manager?.token)}
                />
                <ManagerNotesPanel
                  board={board}
                  date={date}
                  readonly={editsLocked}
                  onToast={showToast}
                  locale={locale}
                  t={t}
                  managerToken={manager?.token ?? null}
                />
              </>
            )}
          </div>
        </div>
      )}

      <MoveReasonModal
        pending={pendingMove}
        onCancel={() => setPendingMove(null)}
        onConfirm={(reason, note) => void confirmClear(reason, note)}
        locale={locale}
        t={t}
      />

      <ManagerUnlockModal
        open={unlockOpen}
        t={t}
        onCancel={() => setUnlockOpen(false)}
        onUnlocked={(session, sessionIdle) => {
          unlock(session, sessionIdle);
          setUnlockOpen(false);
          showToast("ok", t.managerUnlocked(session.name));
        }}
      />
    </div>
  );
}
