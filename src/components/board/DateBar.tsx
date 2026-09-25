import {
  formatDateBarLabel,
  nextImportedDate,
  prevImportedDate,
  resolveTodayInList,
} from "@/lib/date-format";
import { chicagoYmd } from "@/lib/schedule/build-schedule";
import type { Locale, Messages } from "@/lib/i18n";
import { cn } from "@/lib/utils";

type DateBarProps = {
  dates: string[];
  date: string;
  onChange: (date: string) => void;
  locale: Locale;
  t: Messages;
  now: Date;
};

const navButtonClass =
  "touch-target min-h-11 min-w-11 rounded-md border-2 border-neutral-900 bg-white text-lg font-bold text-neutral-900 active:bg-neutral-200 disabled:cursor-not-allowed disabled:opacity-40";

export function DateBar({ dates, date, onChange, locale, t, now }: DateBarProps) {
  const prev = prevImportedDate(dates, date);
  const next = nextImportedDate(dates, date);
  const today = resolveTodayInList(dates, chicagoYmd(now));

  return (
    <div
      className="flex min-h-11 items-center gap-2 text-sm font-semibold"
      data-testid="date-bar"
      data-date={date}
    >
      {t.date}
      <button
        type="button"
        className={navButtonClass}
        onClick={() => prev && onChange(prev)}
        disabled={!prev}
        aria-label={t.datePrev}
        data-testid="date-prev"
      >
        ‹
      </button>
      <span
        className="min-w-[9rem] text-center text-base font-bold"
        data-testid="date-label"
      >
        {date ? formatDateBarLabel(date, locale) : t.noDates}
      </span>
      <button
        type="button"
        className={navButtonClass}
        onClick={() => next && onChange(next)}
        disabled={!next}
        aria-label={t.dateNext}
        data-testid="date-next"
      >
        ›
      </button>
      <button
        type="button"
        className={cn(
          "touch-target min-h-11 rounded-md border-2 border-neutral-900 px-3 text-sm font-bold active:bg-neutral-200 disabled:cursor-not-allowed disabled:opacity-40",
          today === date ? "bg-neutral-900 text-white" : "bg-white text-neutral-900",
        )}
        onClick={() => today && onChange(today)}
        disabled={!today}
        title={!today ? t.todayNotImported : undefined}
        data-testid="date-today"
      >
        {t.today}
      </button>
      {!today && (
        <span
          className="text-xs font-medium text-neutral-600"
          data-testid="date-today-missing"
        >
          {t.todayNotImported}
        </span>
      )}
    </div>
  );
}
