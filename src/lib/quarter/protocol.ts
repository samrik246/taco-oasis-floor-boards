import { z } from "zod";
import { formatInTimeZone } from "date-fns-tz";
import { chicagoHourStart } from "@/lib/hour-grid";
import { TIMEZONE, HOUR_GRID_START, HOUR_GRID_END } from "@/lib/constants";
import { isPaintFamily, type PaintFamily } from "@/lib/assignments/paint-families";
import { QuarterRefused } from "./schema";

const id = z.string().min(1).max(160);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const revision = z.string().regex(/^(0|[1-9][0-9]*)$/);
export const sourceExpectation = z.strictObject({ shiftId:id, employeeId:id, date:z.string(), board:z.enum(["caja","cocina","other"]),
  sourcePosition:z.string(), startAt:z.iso.datetime(), endAt:z.iso.datetime(), supersededAt:z.iso.datetime().nullable(), boardRemoved:z.boolean() });
export const hourExpectation = z.union([
  z.strictObject({ shiftId:id, hourStart:z.iso.datetime(), revision:z.null(), legacySha256:hash }),
  z.strictObject({ shiftId:id, hourStart:z.iso.datetime(), revision }),
]);
const intentBase = { shiftId:id, quarter:z.string().regex(/^\d{2}:(00|15|30|45)$/), granularity:z.enum(["quarter","hour"]).default("quarter"),
  reason:z.string().max(200).optional(), moveNote:z.string().max(2000).nullable().optional() };
export const intentSchema = z.discriminatedUnion("action",[
  z.strictObject({ ...intentBase, action:z.literal("erase") }),
  z.strictObject({ ...intentBase, action:z.literal("station"), stationId:id }),
  z.strictObject({ ...intentBase, action:z.literal("family"), family:z.custom<PaintFamily>(isPaintFamily) }),
]);
export const paintCommandSchema = z.strictObject({ protocol:z.literal(2), requestId:id, capabilitySha256:hash,
  board:z.enum(["caja","cocina"]), date:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  expected:z.strictObject({ databaseEpoch:id, worldRevision:revision }),
  draftSubmission:z.strictObject({ episodeId:id,generationId:id,generationSha256:hash }).optional(),
  sources:z.array(sourceExpectation).min(1).max(500), hours:z.array(hourExpectation).min(1).max(500), intents:z.array(intentSchema).min(1).max(2000) });
export type PaintCommand = z.infer<typeof paintCommandSchema>;
export type PaintIntent = z.infer<typeof intentSchema>;
export const QUARTER_MEDIA_TYPE = "application/vnd.floor-boards.paint-v2+json";
export function quarterInstant(date: string, quarter: string): number {
  const [hour,minute] = quarter.split(":").map(Number);
  if (hour < HOUR_GRID_START || hour >= HOUR_GRID_END || ![0,15,30,45].includes(minute)) throw new QuarterRefused("INVALID_QUARTER",422);
  const start = chicagoHourStart(date,hour).getTime() + minute * 60_000;
  if (!Number.isFinite(start) || formatInTimeZone(new Date(start),TIMEZONE,"yyyy-MM-dd HH:mm") !== `${date} ${quarter}`)
    throw new QuarterRefused("INVALID_QUARTER",422);
  return start;
}
