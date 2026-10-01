import type { PaintCommand, PaintIntent } from "../protocol";
import type { PaintReceipt } from "../transaction";
import { canonicalJson, contentHash, randomId, sha256 } from "./primitives";

export type DraftScope = { managerId: string; board: "caja" | "cocina"; date: string };
export type DraftBase = { localRevision: string; generationId: string | null };
export type DraftHead = DraftScope & DraftBase & { state: "outstanding" | "closed"; pendingRequestId: string | null };
export type RetainedIntent = {
  intentId: string; editedAt: string; intent: PaintIntent;
  source: PaintCommand["sources"][number]; hour: PaintCommand["hours"][number];
  baseWorldRevision: string;
};
export type DraftEnvelope = {
  version: 2; databaseEpoch: string; generationId: string; parentGenerationId: string | null; parentRevision: string;
  episodeId: string; firstDirtyAt: string | null; firstObservedAt: string; timeProvenance: "edited" | "recovered-v1";
  updatedAt: string; baseWorldRevision: string; intents: RetainedIntent[];
  pendingRequestId: string | null; migratedFromV1Sha256: string | null; reviewReasons: string[];
};
export type DraftGeneration = DraftScope & {
  generationId: string; envelope: DraftEnvelope; sha256: string;
  disposition: "head" | "conflict-branch" | "tombstone"; supersedes: string[]; resolves: string[];
};
export type DraftSubmission = DraftScope & {
  requestId: string; requestBytes: string; requestSha256: string; databaseEpoch: string;
  generationId: string; generationSha256: string; episodeId: string; submittedIntentIds: string[];
  state: "prepared" | "confirmed" | "rejected"; response: PaintReceipt | null; rejection: string | null;
};
export type V1Archive = DraftScope & {
  v1Sha256: string; original: string; observedAt: string;
  generationId: string | null; result: "converted" | "review"; staleReason: string | null;
};
export type DraftSnapshot = {
  head: DraftHead | null; generations: DraftGeneration[]; submissions: DraftSubmission[]; archives: V1Archive[]; warnings: string[];
};
export const emptyBase: DraftBase = { localRevision: "0", generationId: null };
export const scopeKey = (s: DraftScope) => [s.managerId, s.board, s.date];
export const sameScope = (a: DraftScope, b: DraftScope) => scopeKey(a).every((v,i)=>v===scopeKey(b)[i]);
export const sameBase = (a: DraftBase | null, b: DraftBase) => (a?.localRevision ?? "0") === b.localRevision && (a?.generationId ?? null) === b.generationId;
export class DraftError extends Error { constructor(public code: string) { super(code); } }
export function assertGeneration(g: DraftGeneration, scope: DraftScope) {
  if (!sameScope(g,scope) || g.envelope.version !== 2 || g.generationId !== g.envelope.generationId || contentHash(g.envelope) !== g.sha256 ||
    !Array.isArray(g.envelope.intents) || new Set(g.envelope.intents.map(i=>i.intentId)).size !== g.envelope.intents.length)
    throw new DraftError("DRAFT_REQUIRES_REVIEW");
}
export function newEnvelope(input: Omit<DraftEnvelope,"version"|"generationId"|"updatedAt">): DraftEnvelope {
  return {...input, version:2, generationId:randomId(), updatedAt:new Date().toISOString()};
}
export function generation(scope: DraftScope, envelope: DraftEnvelope, resolves: string[] = []): DraftGeneration {
  return {...scope,generationId:envelope.generationId,envelope,sha256:contentHash(envelope),
    disposition:envelope.intents.length || envelope.reviewReasons.length ? "head" : "tombstone",
    supersedes:envelope.parentGenerationId ? [envelope.parentGenerationId] : [],resolves};
}
export function commandFor(g: DraftGeneration, capabilitySha256: string, requestId = randomId()): PaintCommand {
  assertGeneration(g,g);
  const e = g.envelope;
  if (!e.intents.length || e.reviewReasons.length) throw new DraftError("DRAFT_REQUIRES_REVIEW");
  const sources = new Map<string,PaintCommand["sources"][number]>(), hours = new Map<string,PaintCommand["hours"][number]>();
  for (const row of e.intents) {
    if (row.baseWorldRevision !== e.baseWorldRevision) throw new DraftError("DRAFT_REQUIRES_REVIEW");
    const source = sources.get(row.source.shiftId), key = `${row.hour.shiftId}|${row.hour.hourStart}`, hour = hours.get(key);
    if ((source && canonicalJson(source) !== canonicalJson(row.source)) || (hour && canonicalJson(hour) !== canonicalJson(row.hour))) throw new DraftError("DRAFT_REQUIRES_REVIEW");
    sources.set(row.source.shiftId,row.source); hours.set(key,row.hour);
  }
  if (hours.size > 500 || e.intents.length > 2000) throw new DraftError("TOO_MANY_INTENTS");
  return {protocol:2,requestId,capabilitySha256,board:g.board,date:g.date,
    expected:{databaseEpoch:e.databaseEpoch,worldRevision:e.baseWorldRevision},
    draftSubmission:{episodeId:e.episodeId,generationId:g.generationId,generationSha256:g.sha256},
    sources:[...sources.values()],hours:[...hours.values()],intents:e.intents.map(i=>i.intent)};
}
export function submissionFor(g: DraftGeneration, command: PaintCommand): DraftSubmission {
  const requestBytes = canonicalJson(command);
  if (new TextEncoder().encode(requestBytes).length > 2 * 1024 * 1024) throw new DraftError("REQUEST_TOO_LARGE");
  return {managerId:g.managerId,board:g.board,date:g.date,requestId:command.requestId,requestBytes,requestSha256:sha256(requestBytes),
    databaseEpoch:g.envelope.databaseEpoch,generationId:g.generationId,generationSha256:g.sha256,episodeId:g.envelope.episodeId,
    submittedIntentIds:g.envelope.intents.map(i=>i.intentId),state:"prepared",response:null,rejection:null};
}
export function assertReceipt(s: DraftSubmission, r: PaintReceipt) {
  if (r.ok !== true || r.requestId !== s.requestId || r.requestSha256 !== s.requestSha256 || r.databaseEpoch !== s.databaseEpoch ||
    r.draftSubmission?.episodeId !== s.episodeId || r.draftSubmission.generationId !== s.generationId || r.draftSubmission.generationSha256 !== s.generationSha256 || !r.dates?.includes(s.date))
    throw new DraftError("RECEIPT_BINDING_MISMATCH");
}
