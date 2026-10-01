import type { CoverPositionInterval } from "@/lib/breaks/cover-positions";
import { breakRange } from "@/lib/breaks/display";
import { boardStationLabel, type Locale } from "@/lib/i18n";

export function CoverPositionDetails({ positions, stations, locale }: {
  positions?: CoverPositionInterval[]; stations: { id: string; label: string }[]; locale: Locale;
}) {
  const es = locale === "es";
  const label = (id: string | null) => id ? boardStationLabel(locale, id, stations) : es ? "Sin puesto asignado" : "No assigned position";
  return <span className="block space-y-1 text-sm font-medium" data-testid="cover-positions">
    {positions?.map(interval => <span className="block" key={interval.startAt}>
      <span className="block font-bold">{breakRange(interval)} · {es ? "Puesto que deja" : "Position vacated"}: {label(interval.vacatedStationId)}</span>
      {interval.moves.map(move => <span className="block" key={move.employeeId}>{move.firstName}: {label(move.fromStationId)} → {label(move.toStationId)}</span>)}
    </span>)}
  </span>;
}
