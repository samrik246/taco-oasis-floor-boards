"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type PerformanceQuestionDto = {
  id: string;
  prompt: string;
  answerType: string;
  required: boolean;
  sortOrder: number;
};

type Props = {
  board: "caja" | "cocina";
  date: string;
  employeeId: string | null;
  employeeName: string | null;
  readonly: boolean;
  onToast: (kind: "ok" | "err", text: string) => void;
};

const OPTIONS: Record<string, { value: string; label: string }[]> = {
  yes_no_na: [
    { value: "yes", label: "Yes" },
    { value: "no", label: "No" },
    { value: "na", label: "N/A" },
  ],
  finished_partial_none: [
    { value: "finished", label: "Finished" },
    { value: "partial", label: "Partial" },
    { value: "none", label: "None" },
  ],
  yes_no_maybe: [
    { value: "yes", label: "Yes" },
    { value: "no", label: "No" },
    { value: "maybe", label: "Maybe" },
  ],
};

/**
 * Minimal close-day performance questions (seed defaults).
 */
export function PerformancePanel({
  board,
  date,
  employeeId,
  employeeName,
  readonly,
  onToast,
}: Props) {
  const [questions, setQuestions] = useState<PerformanceQuestionDto[]>([]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const qs = new URLSearchParams({ board, date });
        if (employeeId) qs.set("employeeId", employeeId);
        const res = await fetch(`/api/performance?${qs}`);
        if (!res.ok) return;
        const data = (await res.json()) as {
          questions: PerformanceQuestionDto[];
          answer?: { answers: Record<string, string> } | null;
        };
        if (cancelled) return;
        setQuestions(data.questions ?? []);
        setAnswers(data.answer?.answers ?? {});
      } catch {
        /* soft */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [board, date, employeeId]);

  async function save() {
    if (readonly || !employeeId || !date) return;
    setSaving(true);
    try {
      const res = await fetch("/api/performance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date, board, employeeId, answers }),
      });
      const data = await res.json();
      if (!res.ok) {
        onToast("err", data.error ?? "Could not save performance");
        return;
      }
      onToast("ok", "Performance answers saved");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section
      className="flex flex-col gap-2 rounded-lg border-2 border-neutral-900 bg-white p-3"
      data-testid="performance-panel"
    >
      <h2 className="text-lg font-bold">Close-day performance</h2>
      {!employeeId ? (
        <p className="text-sm font-medium text-neutral-700">
          Select a person to answer today&apos;s questions.
        </p>
      ) : (
        <>
          <p className="text-sm font-semibold">{employeeName}</p>
          <ul className="flex flex-col gap-3">
            {questions.map((q) => (
              <li key={q.id} className="flex flex-col gap-1">
                <label className="text-xs font-bold text-neutral-800">
                  {q.prompt}
                  {q.required ? " *" : ""}
                </label>
                {q.answerType === "free_note" ? (
                  <textarea
                    className="min-h-16 rounded-md border-2 border-neutral-700 px-2 py-1 text-sm"
                    value={answers[q.id] ?? ""}
                    disabled={readonly}
                    onChange={(e) =>
                      setAnswers((prev) => ({
                        ...prev,
                        [q.id]: e.target.value,
                      }))
                    }
                    data-testid={`perf-${q.id}`}
                  />
                ) : (
                  <select
                    className="touch-target min-h-11 rounded-md border-2 border-neutral-800 bg-white px-2 text-sm font-semibold"
                    value={answers[q.id] ?? ""}
                    disabled={readonly}
                    onChange={(e) =>
                      setAnswers((prev) => ({
                        ...prev,
                        [q.id]: e.target.value,
                      }))
                    }
                    data-testid={`perf-${q.id}`}
                  >
                    <option value="">Select…</option>
                    {(OPTIONS[q.answerType] ?? []).map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                )}
              </li>
            ))}
          </ul>
          <Button
            type="button"
            className={cn("min-h-11 border-2 border-neutral-900")}
            disabled={readonly || saving}
            onClick={() => void save()}
            data-testid="perf-save"
          >
            Save answers
          </Button>
        </>
      )}
    </section>
  );
}
