"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import type { ManagerNoteDto } from "@/lib/notes-types";
import { cn } from "@/lib/utils";
import { boardDisplayName, type Locale, type Messages } from "@/lib/i18n";

type Props = {
  board: "caja" | "cocina";
  date: string;
  readonly: boolean;
  onToast: (kind: "ok" | "err", text: string) => void;
  locale: Locale;
  t: Messages;
};

/**
 * Day notes for board + date. Fills `#manager-notes-slot`.
 * Mutations blocked when `readonly`.
 */
export function ManagerNotesPanel({
  board,
  date,
  readonly,
  onToast,
  locale,
  t,
}: Props) {
  const [notes, setNotes] = useState<ManagerNoteDto[]>([]);
  const [draft, setDraft] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editBody, setEditBody] = useState("");
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!date) {
      setNotes([]);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(
        `/api/notes?board=${board}&date=${encodeURIComponent(date)}`,
      );
      if (!res.ok) {
        onToast("err", "Failed to load notes");
        return;
      }
      const data = (await res.json()) as { notes: ManagerNoteDto[] };
      setNotes(data.notes);
    } finally {
      setLoading(false);
    }
  }, [board, date, onToast]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function addNote() {
    if (readonly || !date || !draft.trim()) return;
    const res = await fetch("/api/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ board, date, body: draft.trim() }),
    });
    const data = await res.json();
    if (!res.ok) {
      onToast("err", data.error ?? "Could not add note");
      return;
    }
    setDraft("");
    onToast("ok", "Note saved");
    await refresh();
  }

  async function saveEdit(id: string) {
    if (readonly || !editBody.trim()) return;
    const res = await fetch(`/api/notes/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: editBody.trim() }),
    });
    const data = await res.json();
    if (!res.ok) {
      onToast("err", data.error ?? "Could not update note");
      return;
    }
    setEditingId(null);
    setEditBody("");
    onToast("ok", "Note updated");
    await refresh();
  }

  async function removeNote(id: string) {
    if (readonly) return;
    const res = await fetch(`/api/notes/${id}`, { method: "DELETE" });
    const data = await res.json();
    if (!res.ok) {
      onToast("err", data.error ?? "Could not delete note");
      return;
    }
    onToast("ok", "Note deleted");
    await refresh();
  }

  return (
    <aside
      id="manager-notes-slot"
      data-board={board}
      data-date={date || undefined}
      data-testid="manager-notes"
      className="flex flex-col gap-2 rounded-lg border-2 border-neutral-900 bg-white p-3"
      aria-label={t.managerNotes}
    >
      <h2 className="text-lg font-bold">{t.managerNotes}</h2>
      <p className="text-xs font-medium text-neutral-600">
        {boardDisplayName(locale, board)}
        {date ? ` · ${date}` : ""}
        {readonly ? ` · ${t.readonly}` : ""}
      </p>

      {!date && (
        <p className="text-sm font-medium text-neutral-700">{t.pickPersonHours}</p>
      )}

      {date && loading && notes.length === 0 && (
        <p className="text-sm font-medium text-neutral-600">{t.loading}</p>
      )}

      {date && !loading && notes.length === 0 && (
        <p
          className="text-sm font-medium text-neutral-600"
          data-testid="notes-empty"
        >
          {t.noNotes}
        </p>
      )}

      <ul className="flex max-h-[40vh] flex-col gap-2 overflow-y-auto xl:max-h-[50vh]">
        {notes.map((n) => (
          <li
            key={n.id}
            className="rounded-md border-2 border-neutral-400 bg-neutral-50 p-2"
            data-testid="manager-note"
            data-note-id={n.id}
          >
            {editingId === n.id ? (
              <div className="flex flex-col gap-2">
                <textarea
                  className="min-h-24 w-full rounded-md border-2 border-neutral-800 bg-white p-2 text-sm font-medium"
                  value={editBody}
                  onChange={(e) => setEditBody(e.target.value)}
                  disabled={readonly}
                  aria-label={t.edit}
                />
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    className="min-h-11"
                    disabled={readonly || !editBody.trim()}
                    onClick={() => void saveEdit(n.id)}
                  >
                    {t.save}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="min-h-11"
                    onClick={() => {
                      setEditingId(null);
                      setEditBody("");
                    }}
                  >
                    {t.cancel}
                  </Button>
                </div>
              </div>
            ) : (
              <>
                <p className="whitespace-pre-wrap text-sm font-medium text-neutral-950">
                  {n.body}
                </p>
                <p className="mt-1 text-xs font-semibold text-neutral-600">
                  {n.author} · {n.chicagoTimestamp} CT
                </p>
                {!readonly && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button
                      type="button"
                      className="touch-target min-h-11 rounded-md border-2 border-neutral-800 px-3 text-sm font-semibold active:bg-neutral-200"
                      onClick={() => {
                        setEditingId(n.id);
                        setEditBody(n.body);
                      }}
                    >
                      {t.edit}
                    </button>
                    <button
                      type="button"
                      className="touch-target min-h-11 rounded-md border-2 border-red-800 px-3 text-sm font-semibold text-red-950 active:bg-red-100"
                      onClick={() => void removeNote(n.id)}
                    >
                      {t.delete}
                    </button>
                  </div>
                )}
              </>
            )}
          </li>
        ))}
      </ul>

      {!readonly && date && (
        <div className="mt-auto flex flex-col gap-2 border-t-2 border-neutral-300 pt-2">
          <label className="text-xs font-bold uppercase tracking-wide text-neutral-700">
            {t.addNote}
            <textarea
              className={cn(
                "mt-1 min-h-20 w-full rounded-md border-2 border-neutral-800 bg-white p-2 text-sm font-medium normal-case text-neutral-900",
              )}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={t.notePlaceholderDay}
              data-testid="notes-draft"
              aria-label={t.addNote}
            />
          </label>
          <Button
            type="button"
            className="min-h-11 border-2 border-neutral-900"
            disabled={!draft.trim()}
            onClick={() => void addNote()}
            data-testid="notes-add"
          >
            {t.addNote}
          </Button>
        </div>
      )}
    </aside>
  );
}
