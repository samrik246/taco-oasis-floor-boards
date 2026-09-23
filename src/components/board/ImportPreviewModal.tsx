"use client";

import { Button } from "@/components/ui/button";
import { formatHourLabel } from "@/lib/hour-grid";
import { stationLabel, type Locale, type Messages } from "@/lib/i18n";
import type { DatePreview, Refusal } from "@/lib/import/reconcile";

export type ImportPreviewData = {
  fingerprint: string;
  planDigest: string;
  needsConfirm: boolean;
  dates: DatePreview[];
  refusals: Refusal[];
};

type Props = {
  preview: ImportPreviewData | null;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  locale: Locale;
  t: Messages;
};

/** Same-day re-import preview (C1): counts per date, removals, Confirm. No names. */
export function ImportPreviewModal({ preview, busy, onCancel, onConfirm, locale, t }: Props) {
  if (!preview) return null;
  const refused = preview.refusals.length > 0;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="import-preview-title"
      data-testid="import-preview-modal"
    >
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-lg border-2 border-neutral-900 bg-white p-4 shadow-lg">
        <h2 id="import-preview-title" className="text-lg font-bold">
          {refused ? t.importRefusedTitle : t.importPreviewTitle}
        </h2>
        {refused ? (
          <ul className="mt-2 list-disc pl-5 text-sm font-medium text-red-800" data-testid="import-refusals">
            {preview.refusals.map((r, i) => (
              <li key={i}>{r.message}</li>
            ))}
          </ul>
        ) : (
          <p className="mt-1 text-sm font-medium text-neutral-700">{t.importPreviewIntro}</p>
        )}

        {!refused &&
          preview.dates.map((d) => (
            <section
              key={d.date}
              className="mt-3 rounded-md border border-neutral-300 p-2"
              data-testid={`import-preview-${d.date}`}
            >
              <h3 className="text-sm font-bold">{d.date}</h3>
              <p className="text-sm tabular-nums">{t.importCounts(d)}</p>
              <p className="text-sm tabular-nums">{t.importKept(d.assignmentsKept)}</p>
              {d.skippedOpenShifts > 0 && (
                <p className="text-sm tabular-nums">{t.importOpenShifts(d.skippedOpenShifts)}</p>
              )}
              {d.assignmentsToRemove.length === 0 ? (
                <p className="mt-1 text-xs font-medium text-neutral-600">{t.importRemoveNone}</p>
              ) : (
                <>
                  <p className="mt-1 text-xs font-bold">{t.importRemoveTitle}</p>
                  <ul className="mt-1 text-xs" data-testid="import-removals">
                    {d.assignmentsToRemove.map((r, i) => (
                      <li key={i}>
                        {formatHourLabel(r.hour)} · {stationLabel(locale, r.stationId, r.stationId)}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </section>
          ))}

        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            className="min-h-11 border-2"
            onClick={onCancel}
            disabled={busy}
            data-testid="import-preview-cancel"
          >
            {t.cancel}
          </Button>
          {!refused && (
            <Button
              type="button"
              className="min-h-11 border-2 border-neutral-900"
              onClick={onConfirm}
              disabled={busy}
              data-testid="import-preview-confirm"
            >
              {t.importConfirm}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
