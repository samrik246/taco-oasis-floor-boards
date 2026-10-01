import { formatInTimeZone } from "date-fns-tz";
import { chicagoHourStart } from "@/lib/hour-grid";
import { TIMEZONE, HOUR_GRID_START, HOUR_GRID_END } from "@/lib/constants";
import { QuarterRefused } from "./schema";

import { paintCommandSchema, type PaintCommand } from "./protocol-shapes";
export { sourceExpectation, hourExpectation, intentSchema, paintCommandSchema } from "./protocol-shapes";
export type { PaintCommand, PaintIntent } from "./protocol-shapes";
export function parsePaintCommand(input:unknown):PaintCommand {
  const raw=input as Partial<PaintCommand>|null;
  if(raw && ((Array.isArray(raw.hours)&&raw.hours.length>500)||(Array.isArray(raw.sources)&&raw.sources.length>500)||(Array.isArray(raw.intents)&&raw.intents.length>2000)))throw new QuarterRefused("TOO_MANY_INTENTS",413);
  return paintCommandSchema.parse(input);
}
export const QUARTER_MEDIA_TYPE = "application/vnd.floor-boards.paint-v2+json";
export function quarterInstant(date: string, quarter: string): number {
  const [hour,minute] = quarter.split(":").map(Number);
  if (hour < HOUR_GRID_START || hour >= HOUR_GRID_END || ![0,15,30,45].includes(minute)) throw new QuarterRefused("INVALID_QUARTER",422);
  const start = chicagoHourStart(date,hour).getTime() + minute * 60_000;
  if (!Number.isFinite(start) || formatInTimeZone(new Date(start),TIMEZONE,"yyyy-MM-dd HH:mm") !== `${date} ${quarter}`)
    throw new QuarterRefused("INVALID_QUARTER",422);
  return start;
}
