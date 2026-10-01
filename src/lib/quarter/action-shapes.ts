import { z } from "zod";
import { paintCommandSchema, sourceExpectation, hourExpectation } from "./protocol-shapes";

const envelope=paintCommandSchema.omit({intents:true});
const reason={reason:z.string().max(200).optional(),moveNote:z.string().max(2000).nullable().optional()};
export const operationSchema=z.discriminatedUnion("operation",[
  envelope.extend({operation:z.literal("whole-shift"),shiftId:z.string().min(1),stationId:z.string().min(1).nullable(),...reason}),
  envelope.extend({operation:z.literal("swap"),leftShiftId:z.string().min(1),rightShiftId:z.string().min(1),quarter:z.string(),granularity:z.enum(["hour","quarter"]),...reason}),
  envelope.extend({operation:z.literal("copy"),sourceDate:z.iso.date(),sourceSources:z.array(sourceExpectation),sourceHours:z.array(hourExpectation),
    mode:z.enum(["preview","commit"]),previewSha256:z.string().regex(/^[a-f0-9]{64}$/).optional(),
    mapping:z.array(z.strictObject({fromShiftId:z.string().min(1),toShiftId:z.string().min(1)})).min(1).max(500)}),
]);
export type QuarterOperation=z.infer<typeof operationSchema>;

const base={protocol:z.literal(2),requestId:z.string().min(1).max(160),capabilitySha256:z.string(),date:z.iso.date(),
  expected:z.strictObject({databaseEpoch:z.string(),worldRevision:z.string().regex(/^(0|[1-9][0-9]*)$/)})};
export const tareaCommandSchema=z.discriminatedUnion("operation",[
  z.strictObject({...base,operation:z.literal("assign"),employeeId:z.string().min(1),templateId:z.string().min(1),quarter:z.string(),granularity:z.enum(["hour","quarter"]),forceLemon:z.boolean().optional()}),
  z.strictObject({...base,operation:z.literal("status"),id:z.string().min(1),status:z.enum(["working","done"])}),
]);
const removalBase={protocol:z.literal(2),requestId:z.string().min(1).max(160),capabilitySha256:z.string(),date:z.iso.date(),board:z.enum(["caja","cocina"]),reason:z.string().trim().min(1).max(2000)};
const removalExpected=z.strictObject({databaseEpoch:z.string(),worldRevision:z.string(),sourceSha256:z.string(),removalRevision:z.number().int().nonnegative()});
export const removalCommandSchema=z.discriminatedUnion("operation",[
  z.strictObject({...removalBase,expected:removalExpected,shiftId:z.string().min(1),operation:z.literal("remove"),positions:z.enum(["replay","none"]).optional()}),
  z.strictObject({...removalBase,expected:removalExpected,shiftId:z.string().min(1),operation:z.literal("restore"),positions:z.enum(["replay","none"]).optional()}),
  z.strictObject({...removalBase,expected:removalExpected.omit({sourceSha256:true}),removalId:z.string().min(1),operation:z.literal("resolve")}),
]);
