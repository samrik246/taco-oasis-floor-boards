"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { tareaLabel, type Locale, type Messages } from "@/lib/i18n";

export type TareaTemplateDto = {
  id: string;
  code: string;
  label: string;
  mode: string;
  lemonWarnOnGreens: boolean;
};

export type TareaAssignmentDto = {
  id: string;
  status: string;
  forceLemon: boolean;
  template: TareaTemplateDto;
  employee: {
    id: string;
    firstName: string;
    lastName: string;
    externalId: string;
  };
};

export type SuggestionDto = {
  label: "top" | "next";
  employeeId: string;
  displayName: string;
  seatId: string | null;
};

type Props = {
  templates: TareaTemplateDto[];
  assignments: TareaAssignmentDto[];
  suggestions: SuggestionDto[];
  selectedTemplateId: string | null;
  onSelectTemplate: (id: string) => void;
  onAssign: (employeeId: string, forceLemon: boolean) => void;
  onMarkDone: (id: string) => void;
  onMarkWorking: (id: string) => void;
  readonly: boolean;
  compact?: boolean;
  locale: Locale;
  t: Messages;
};

export function TareasPanel({
  templates,
  assignments,
  suggestions,
  selectedTemplateId,
  onSelectTemplate,
  onAssign,
  onMarkDone,
  onMarkWorking,
  readonly,
  compact,
  locale,
  t,
}: Props) {
  const [forceLemon, setForceLemon] = useState(false);
  const working = assignments.filter((a) => a.status === "working");
  const done = assignments.filter((a) => a.status === "done");
  const backlog = templates.filter((tpl) => tpl.mode === "backlog_when_slow");

  useEffect(() => {
    setForceLemon(false);
  }, [selectedTemplateId]);

  return (
    <section
      className={cn(
        "flex flex-col gap-3 rounded-lg border-2 border-neutral-900 bg-white p-3",
        compact && "p-2",
      )}
      data-testid="tareas-panel"
    >
      <h2 className="text-lg font-bold">{t.tareasTitle}</h2>
      <p className="text-xs font-medium text-neutral-600">{t.tareasHint}</p>

      {backlog.length > 0 && (
        <p
          className="rounded-md border border-dashed border-neutral-500 px-2 py-1 text-xs font-semibold text-neutral-700"
          data-testid="chiles-backlog-note"
        >
          {t.backlogWhenSlow}:{" "}
          {backlog
            .map((tpl) => tareaLabel(locale, tpl.id, tpl.label))
            .join(", ")}
        </p>
      )}

      <label className="flex flex-col gap-1 text-xs font-bold uppercase tracking-wide text-neutral-700">
        {t.assignTarea}
        <select
          className="touch-target min-h-11 rounded-md border-2 border-neutral-800 bg-white px-2 text-sm font-semibold normal-case text-neutral-900"
          value={selectedTemplateId ?? ""}
          onChange={(e) => onSelectTemplate(e.target.value)}
          disabled={readonly}
          data-testid="tarea-template-select"
        >
          <option value="">{t.pickTarea}…</option>
          {templates.map((tpl) => (
            <option key={tpl.id} value={tpl.id}>
              {tareaLabel(locale, tpl.id, tpl.label)}
              {tpl.mode === "backlog_when_slow"
                ? ` (${t.backlogWhenSlow})`
                : ""}
            </option>
          ))}
        </select>
      </label>

      {selectedTemplateId && (
        <div className="flex flex-col gap-2" data-testid="tarea-suggestions">
          <div className="text-xs font-bold uppercase text-neutral-700">
            {t.suggestions}
          </div>
          {suggestions.length === 0 && (
            <p className="text-sm font-medium text-neutral-600">
              {t.noOneAvailable}
            </p>
          )}
          {suggestions.slice(0, 6).map((s) => (
            <button
              key={`${s.label}-${s.employeeId}`}
              type="button"
              disabled={readonly}
              onClick={() => onAssign(s.employeeId, forceLemon)}
              className="flex min-h-12 items-center justify-between rounded-md border-2 border-neutral-700 bg-neutral-50 px-3 text-left text-sm font-bold active:bg-neutral-200 disabled:opacity-50"
              data-testid={`suggest-${s.label}-${s.employeeId}`}
            >
              <span>
                <span className="mr-2 text-xs font-bold uppercase text-neutral-500">
                  {s.label === "top" ? t.top : t.next}
                </span>
                {s.displayName}
              </span>
              <span className="text-xs font-medium text-neutral-600">
                {s.seatId ?? "—"}
              </span>
            </button>
          ))}
          <label className="flex min-h-11 items-center gap-2 text-xs font-semibold">
            <input
              type="checkbox"
              className="size-4 accent-neutral-900"
              checked={forceLemon}
              onChange={(e) => setForceLemon(e.target.checked)}
              disabled={readonly}
              data-testid="force-lemon"
            />
            {t.forceLemon}
          </label>
        </div>
      )}

      <div>
        <h3 className="mb-1 text-sm font-bold">
          {t.working} ({working.length})
        </h3>
        <ul
          className="flex max-h-40 flex-col gap-1 overflow-y-auto"
          data-testid="tareas-working"
        >
          {working.length === 0 && (
            <li className="text-sm font-medium text-neutral-600">
              {t.noWorking}
            </li>
          )}
          {working.map((a) => (
            <li
              key={a.id}
              className="flex min-h-11 items-center justify-between gap-2 rounded border border-neutral-400 px-2 py-1 text-sm"
            >
              <span className="font-semibold">
                {a.employee.firstName} —{" "}
                {tareaLabel(locale, a.template.id, a.template.label)}
              </span>
              {!readonly && (
                <Button
                  type="button"
                  size="sm"
                  className="min-h-11 border border-neutral-800"
                  onClick={() => onMarkDone(a.id)}
                  data-testid={`tarea-done-${a.id}`}
                >
                  {t.markDone}
                </Button>
              )}
            </li>
          ))}
        </ul>
      </div>

      <div className={cn(!compact && "hidden xl:block")}>
        <h3 className="mb-1 text-sm font-bold">
          {t.done} ({done.length})
        </h3>
        <ul
          className="flex max-h-28 flex-col gap-1 overflow-y-auto"
          data-testid="tareas-done"
        >
          {done.length === 0 && (
            <li className="text-sm font-medium text-neutral-600">{t.noDone}</li>
          )}
          {done.slice(0, 12).map((a) => (
            <li
              key={a.id}
              className="flex min-h-10 items-center justify-between gap-2 text-sm text-neutral-700"
            >
              <span>
                {a.employee.firstName} —{" "}
                {tareaLabel(locale, a.template.id, a.template.label)}
              </span>
              {!readonly && (
                <button
                  type="button"
                  className="min-h-11 text-xs font-bold underline"
                  onClick={() => onMarkWorking(a.id)}
                >
                  {t.markWorking}
                </button>
              )}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
