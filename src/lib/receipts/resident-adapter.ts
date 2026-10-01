import { z } from "zod";
import { id, parseCommand, RECEIPT_DEVICES, refusal, type Command } from "./protocol";
import { translateResult, type DurableReceiptAdapter, type ExecutionContext, type HostCommand, type Lookup, type Plan, type Resolution } from "./host";
import { canonical, decodeLine, hashSchema, LIMITS, type CallInput, type Frame } from "./transport-codec";
import { HistoryUnavailable, ReceiptWorkerSupervisor, UnknownCompletion } from "./transport-supervisor";

const resolution = <T extends z.ZodType,>(schema: T) => z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("resolved"), value: schema }).strict(),
  z.object({ kind: z.literal("unavailable"), reason: z.enum(["history_unavailable", "source_unavailable"]) }).strict(),
  z.object({ kind: z.literal("refused"), reason: z.literal("unauthorized") }).strict(),
]);
const failureLine = (command: Command, reason: "history_unavailable" | "gate_off") => JSON.stringify({ ...refusal(command, reason, reason === "gate_off" ? "refused" : "unavailable"), schema: "receipt-result/v1" }) + "\n";

/** Offline-only wiring. The production route has no supervisor or engine. */
export function residentAdapter(supervisor: ReceiptWorkerSupervisor, devices: readonly string[] = RECEIPT_DEVICES): DurableReceiptAdapter {
  async function call(input: CallInput): Promise<Frame> {
    const frame = await supervisor.call(input);
    if (frame.header.status === "history_unavailable") throw new HistoryUnavailable();
    return frame;
  }
  async function invalid(): Promise<never> { await supervisor.stop(); throw new UnknownCompletion(); }
  async function checkedResult(frame: Frame, command: Command) {
    try { return await translateResult(frame.body.toString("utf8"), command, devices); }
    catch { return invalid(); }
  }
  return {
    async lookupRequest(context: ExecutionContext): Promise<Lookup> {
      let frame: Frame;
      try { frame = await call({ method: "lookup_request", authenticated_actor: context.authenticatedActor, args: { browser_command: context.browserCommand } }); }
      catch (e) { if (e instanceof HistoryUnavailable) return { kind: "unavailable", result: failureLine(context.browserCommand, "history_unavailable") }; throw e; }
      const kind = frame.header.kind;
      if (kind === "absent") return { kind };
      const value = await checkedResult(frame, context.browserCommand);
      if (kind === "conflict" && (value.state !== "refused" || value.reason !== "request_conflict" || value.data !== null)) return invalid();
      if (kind === "unavailable" && (value.state !== "unavailable" || value.reason !== "history_unavailable" || value.data !== null)) return invalid();
      if (kind !== "bound" && kind !== "conflict" && kind !== "unavailable") return invalid();
      return { kind, result: frame.body.toString("utf8") };
    },
    async contentHandles(actor: string, handles: string[]): Promise<Resolution<string[]>> {
      let frame: Frame;
      try { frame = await call({ method: "content_handles", authenticated_actor: actor, args: { handles } }); }
      catch (e) { if (e instanceof HistoryUnavailable) return { kind: "unavailable", reason: "history_unavailable" }; throw e; }
      try {
        return resolution(z.array(id).length(handles.length).refine((xs) => new Set(xs).size === xs.length)).parse(decodeLine(frame.body, LIMITS.resolution));
      } catch { return invalid(); }
    },
    async plan(actor: string, review: string): Promise<Resolution<Plan>> {
      let frame: Frame;
      try { frame = await call({ method: "plan", authenticated_actor: actor, args: { review_handle: review } }); }
      catch (e) { if (e instanceof HistoryUnavailable) return { kind: "unavailable", reason: "history_unavailable" }; throw e; }
      try { return resolution(z.object({ plan_id: id, plan_sha256: hashSchema }).strict()).parse(decodeLine(frame.body, LIMITS.resolution)); }
      catch { return invalid(); }
    },
    async execute(command: HostCommand, context: ExecutionContext): Promise<string> {
      if (command.op === "status_refresh") {
        const browser = parseCommand(context.browserCommand, devices);
        id.parse(context.authenticatedActor);
        if (command.schema !== "receipt-command/v1" || browser.op !== command.op || command.request_id !== browser.request_id || command.actor_id !== context.authenticatedActor || canonical(command.args) !== canonical(browser.args) || Object.keys(command).sort().join(",") !== "actor_id,args,op,request_id,schema") throw new UnknownCompletion();
        return failureLine(browser, "gate_off");
      }
      let frame: Frame;
      try { frame = await call({ method: "execute_browser", authenticated_actor: context.authenticatedActor, args: { browser_command: context.browserCommand, host_command: command } }); }
      catch (e) { if (e instanceof HistoryUnavailable) return failureLine(context.browserCommand, "history_unavailable"); throw e; }
      await checkedResult(frame, context.browserCommand);
      return frame.body.toString("utf8");
    },
  };
}
