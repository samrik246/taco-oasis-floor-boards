import { z } from "zod";
import { isPaintFamily, type PaintFamily } from "@/lib/assignments/paint-families";
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
  board:z.enum(["caja","cocina"]), date:z.iso.date(),
  expected:z.strictObject({ databaseEpoch:id, worldRevision:revision }),
  draftSubmission:z.strictObject({ episodeId:id,generationId:id,generationSha256:hash }).optional(),
  sources:z.array(sourceExpectation).min(1).max(500), hours:z.array(hourExpectation).min(1).max(500), intents:z.array(intentSchema).min(1).max(2000) });
export type PaintCommand = z.infer<typeof paintCommandSchema>;
export type PaintIntent = z.infer<typeof intentSchema>;
