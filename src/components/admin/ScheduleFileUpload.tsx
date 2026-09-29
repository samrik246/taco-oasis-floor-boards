"use client";

import { useState } from "react";
import { ImportPreviewModal, type ImportPreviewData } from "@/components/board/ImportPreviewModal";
import { messagesFor, type Locale } from "@/lib/i18n";
import { managerAuthHeaders } from "@/lib/managers/auth-headers";

/** The file picker that used to sit on the board. Preview, then confirm. */
export function ScheduleFileUpload({ token, locale }: { token: string; locale: Locale }) {
  const t = messagesFor(locale);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ file: File; data: ImportPreviewData } | null>(null);

  async function postImport(file: File, fields: Record<string, string>) {
    const form = new FormData();
    form.set("file", file);
    for (const [key, value] of Object.entries(fields)) form.set(key, value);
    const res = await fetch("/api/imports", {
      method: "POST",
      headers: managerAuthHeaders(token),
      body: form,
    });
    return { ok: res.ok, data: (await res.json()) as Record<string, unknown> & { error?: string } };
  }

  async function commit(file: File, data: ImportPreviewData, updated: boolean) {
    const res = await postImport(file, {
      mode: "commit",
      fingerprint: data.fingerprint,
      planDigest: data.planDigest,
    });
    if (!res.ok) {
      setError(res.data.error ?? t.toastUploadFailed);
      if (res.data.code === "BOARD_CHANGED") {
        const fresh = await postImport(file, { mode: "preview" });
        if (fresh.ok) setPreview({ file, data: fresh.data as ImportPreviewData });
        else setPreview(null);
      }
      return;
    }
    setPreview(null);
    setError(null);
    setNotice(
      updated ? t.toastScheduleUpdated : t.toastImported(Number(res.data.rowCount ?? 0)),
    );
  }

  async function onFile(file: File | null) {
    if (!file) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const previewRes = await postImport(file, { mode: "preview" });
      if (!previewRes.ok) {
        setError(previewRes.data.error ?? t.toastUploadFailed);
        return;
      }
      const data = previewRes.data as ImportPreviewData;
      if (data.refusals.length > 0 || data.needsConfirm) {
        setPreview({ file, data });
        return;
      }
      await commit(file, data, false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <label className="inline-flex min-h-11 w-fit cursor-pointer items-center rounded-md border-2 border-neutral-900 bg-white px-4 text-sm font-semibold">
        {t.upload}
        <input
          type="file"
          accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
          className="sr-only"
          disabled={busy}
          data-testid="back-office-upload"
          onChange={(event) => {
            void onFile(event.target.files?.[0] ?? null);
            event.target.value = "";
          }}
        />
      </label>
      {notice && <p className="text-sm font-semibold text-emerald-900" data-testid="back-office-upload-notice">{notice}</p>}
      {error && <p className="text-sm font-semibold text-red-900">{error}</p>}
      <ImportPreviewModal
        preview={preview?.data ?? null}
        busy={busy}
        onCancel={() => setPreview(null)}
        onConfirm={() => {
          if (!preview) return;
          setBusy(true);
          void commit(preview.file, preview.data, true).finally(() => setBusy(false));
        }}
        locale={locale}
        t={t}
      />
    </div>
  );
}
