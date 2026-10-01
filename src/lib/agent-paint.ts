import { requireLegacy } from "@/lib/quarter/schema";
/**
 * Host-side colour edits. Preflight resolves and checks a packet without
 * writing. Apply holds the release lock, re-reads RELEASE_SHA, then resolves,
 * validates, and saves through paintAssignments before releasing the lock.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/db";
import { paintAssignments, type PaintEdit, type PaintRequest } from "@/lib/assignments/paint";
import { isPaintFamily, PAINT_FAMILIES, type PaintFamily } from "@/lib/assignments/paint-families";
import { BOARD_CHANGE_ROUTES } from "@/lib/board-change-log";
import { HOUR_GRID_END, HOUR_GRID_START } from "@/lib/constants";
import { chicagoHourEnd, chicagoHourStart } from "@/lib/hour-grid";
import { acquireReleaseLock, releaseReleaseLock } from "@/lib/release-lock";
import { isHourInShift } from "@/lib/rules/shift-window";

export const AGENT_PAINT_TEXT = {
  taken: "That seat is already taken.",
  blocked: "This person cannot take that position.",
  offShift: "That hour is outside the shift.",
  stale: "The board changed since preflight.",
  refused: "The edit was refused.",
  packet: "The packet is not valid.",
  sha: "The packet SHA-256 does not match.",
  release: "The installed release does not match the packet.",
  lock: "The release lock is held.",
  manyShifts: "More than one active shift covers that hour.",
  failed: "The command failed.",
} as const;

const LEVEL_WORD = /\b(forbidden|training|ok|preferred)\b/i;
const ID_TEXT = /^[A-Za-z0-9_-]{1,80}$/;
const RELEASE_TEXT = /^[0-9a-f]{40}$/;
const SHA_TEXT = /^[0-9a-f]{64}$/;
const AGENT_TEXT = /^[A-Za-z0-9](?:[A-Za-z0-9 ]{0,38}[A-Za-z0-9])?$/;

export class AgentPaintExit extends Error {
  readonly exitCode: number;

  constructor(exitCode: number, detail: string) {
    super(detail);
    this.name = "AgentPaintExit";
    this.exitCode = exitCode;
  }
}

type BoardName = "caja" | "cocina";

type ExpectedShift = {
  startAt: string;
  endAt: string;
  employeeId: string;
  sourcePosition: string;
};

type ExpectedCell = { id: string; stationId: string } | null;

type Target =
  | { kind: "station"; stationId: string }
  | { kind: "family"; family: PaintFamily }
  | { kind: "erase" };

type RequestEdit = { employeeId: string; hour: number; target: Target };

type RequestPacket = {
  version: 1;
  release: string;
  board: BoardName;
  date: string;
  agent: string;
  edits: RequestEdit[];
};

export type ResolvedEdit = {
  employeeId: string;
  hour: number;
  shiftId: string;
  expectedShift: ExpectedShift;
  expected: ExpectedCell;
  stationId?: string;
  family?: PaintFamily;
  erase?: true;
};

export type ResolvedPacket = {
  version: 1;
  release: string;
  board: BoardName;
  date: string;
  agent: string;
  edits: ResolvedEdit[];
};

type CellView = {
  employeeId: string;
  name: string;
  hour: number;
  before: string | null;
  after: string | null;
  family?: PaintFamily;
};

type PaintCall = Awaited<ReturnType<typeof paintAssignments>>;

export type AgentPaintDeps = {
  readReleaseSha: (appDir: string) => Promise<string>;
  acquireLock: (appDir: string) => Promise<boolean>;
  releaseLock: (appDir: string) => Promise<void>;
  resolve: (packet: ResolvedPacket) => Promise<ResolvedPacket>;
  validate: (packet: ResolvedPacket) => Promise<PaintCall>;
  paint: (packet: ResolvedPacket) => Promise<PaintCall>;
};

export type AgentPaintResult = { code: number; stdout: string; stderr: string };

function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function seal(detail: string): string {
  return LEVEL_WORD.test(detail) ? AGENT_PAINT_TEXT.refused : detail;
}

function fail(code: number, detail: string): AgentPaintResult {
  const error = code === 2 ? "refused" : code === 3 ? "packet" : code === 4 ? "release" : "command";
  return { code, stdout: "", stderr: line({ error, detail: seal(detail) }) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function keySet(value: Record<string, unknown>): string {
  return Object.keys(value).sort().join(",");
}

function packetError(): never {
  throw new AgentPaintExit(3, AGENT_PAINT_TEXT.packet);
}

function readJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    packetError();
  }
}

function validDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function validInstant(value: unknown): value is string {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && !Number.isNaN(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function validLabel(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 120 && !/[\u0000-\u001f]/.test(value);
}

function validId(value: unknown): value is string {
  return typeof value === "string" && ID_TEXT.test(value);
}

function header(value: Record<string, unknown>, keys: string): { release: string; board: BoardName; date: string; agent: string } | null {
  if (keySet(value) !== keys) return null;
  if (value.version !== 1 || typeof value.release !== "string" || !RELEASE_TEXT.test(value.release)) return null;
  if (value.board !== "caja" && value.board !== "cocina") return null;
  if (typeof value.date !== "string" || !validDate(value.date)) return null;
  if (typeof value.agent !== "string" || !AGENT_TEXT.test(value.agent)) return null;
  if (!Array.isArray(value.edits) || value.edits.length < 1 || value.edits.length > 100) return null;
  return { release: value.release, board: value.board, date: value.date, agent: value.agent };
}

function readTarget(edit: Record<string, unknown>): Target | null {
  if (typeof edit.stationId === "string") {
    return validId(edit.stationId) ? { kind: "station", stationId: edit.stationId } : null;
  }
  if (typeof edit.family === "string") {
    return isPaintFamily(edit.family) ? { kind: "family", family: edit.family } : null;
  }
  if (edit.erase === true) return { kind: "erase" };
  return null;
}

function readHour(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= HOUR_GRID_START && value < HOUR_GRID_END
    ? value
    : null;
}

function readExpectedShift(value: unknown): ExpectedShift | null {
  if (!isRecord(value) || keySet(value) !== "employeeId,endAt,sourcePosition,startAt") return null;
  if (!validInstant(value.startAt) || !validInstant(value.endAt) || !validId(value.employeeId) || !validLabel(value.sourcePosition)) {
    return null;
  }
  return {
    startAt: value.startAt,
    endAt: value.endAt,
    employeeId: value.employeeId,
    sourcePosition: value.sourcePosition,
  };
}

function readExpected(value: unknown): ExpectedCell | undefined {
  if (value === null) return null;
  if (!isRecord(value) || keySet(value) !== "id,stationId" || !validId(value.id) || !validId(value.stationId)) return undefined;
  return { id: value.id, stationId: value.stationId };
}

function withTarget(base: Omit<ResolvedEdit, "stationId" | "family" | "erase">, target: Target): ResolvedEdit {
  if (target.kind === "station") return { ...base, stationId: target.stationId };
  if (target.kind === "family") return { ...base, family: target.family };
  return { ...base, erase: true };
}

function parseRequestPacket(raw: string): RequestPacket {
  const value = readJson(raw);
  if (!isRecord(value)) packetError();
  const top = header(value, "agent,board,date,edits,release,version");
  if (!top) packetError();
  const edits: RequestEdit[] = [];
  const seen = new Set<string>();
  for (const item of value.edits as unknown[]) {
    if (!isRecord(item)) packetError();
    const keys = keySet(item);
    if (keys !== "employeeId,hour,stationId" && keys !== "employeeId,family,hour" && keys !== "employeeId,erase,hour") packetError();
    const hour = readHour(item.hour);
    const target = readTarget(item);
    if (!validId(item.employeeId) || hour === null || !target) packetError();
    const personHour = `${item.employeeId}|${hour}`;
    if (seen.has(personHour)) packetError();
    seen.add(personHour);
    edits.push({ employeeId: item.employeeId, hour, target });
  }
  return { version: 1, ...top, edits };
}

export function parseResolvedPacket(raw: string): ResolvedPacket {
  const value = readJson(raw);
  if (!isRecord(value)) packetError();
  const top = header(value, "agent,board,date,edits,release,version");
  if (!top) packetError();
  const edits: ResolvedEdit[] = [];
  const seen = new Set<string>();
  for (const item of value.edits as unknown[]) {
    if (!isRecord(item)) packetError();
    const keys = keySet(item);
    const stationKeys = "employeeId,expected,expectedShift,hour,shiftId,stationId";
    const eraseKeys = "employeeId,erase,expected,expectedShift,hour,shiftId";
    if (keys !== stationKeys && keys !== eraseKeys) packetError();
    const hour = readHour(item.hour);
    const target = readTarget(item);
    const expectedShift = readExpectedShift(item.expectedShift);
    const expected = readExpected(item.expected);
    if (!validId(item.employeeId) || !validId(item.shiftId) || hour === null || !target || !expectedShift || expected === undefined) {
      packetError();
    }
    if (expectedShift.employeeId !== item.employeeId) packetError();
    const personHour = `${item.employeeId}|${hour}`;
    if (seen.has(personHour)) packetError();
    seen.add(personHour);
    edits.push(withTarget({
      employeeId: item.employeeId,
      hour,
      shiftId: item.shiftId,
      expectedShift,
      expected,
    }, target));
  }
  return { version: 1, ...top, edits };
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (isRecord(value)) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) sorted[key] = sortValue(value[key]);
    return sorted;
  }
  return value;
}

export function packetSha256(packet: unknown): string {
  return createHash("sha256").update(JSON.stringify(sortValue(packet))).digest("hex");
}

async function readInstalledRelease(appDir: string): Promise<string> {
  try {
    const text = await readFile(path.join(appDir, "RELEASE_SHA"), "utf8");
    const sha = text.trim();
    if (!RELEASE_TEXT.test(sha)) throw new AgentPaintExit(4, AGENT_PAINT_TEXT.release);
    return sha;
  } catch (error) {
    if (error instanceof AgentPaintExit) throw error;
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code === "ENOENT") throw new AgentPaintExit(4, AGENT_PAINT_TEXT.release);
    throw new AgentPaintExit(1, AGENT_PAINT_TEXT.failed);
  }
}

async function resolveRequest(packet: RequestPacket): Promise<{ packet: ResolvedPacket; cells: CellView[] }> {
  await requireLegacy(prisma);
  const edits: ResolvedEdit[] = [];
  const cells: CellView[] = [];
  for (const edit of packet.edits) {
    const shifts = await prisma.shift.findMany({
      where: {
        employeeId: edit.employeeId,
        date: packet.date,
        board: packet.board,
        supersededAt: null,
        boardRemoved: false,
      },
    });
    const hourStart = chicagoHourStart(packet.date, edit.hour);
    const covering = shifts.filter((shift) =>
      isHourInShift(hourStart, shift.startAt, shift.endAt, chicagoHourEnd(packet.date, edit.hour)),
    );
    if (covering.length === 0) throw new AgentPaintExit(2, AGENT_PAINT_TEXT.offShift);
    if (covering.length > 1) throw new AgentPaintExit(2, AGENT_PAINT_TEXT.manyShifts);
    const shift = covering[0]!;
    const current = await prisma.assignment.findFirst({
      where: { employeeId: edit.employeeId, hourStart },
    });
    const employee = await prisma.employee.findUnique({ where: { id: edit.employeeId } });
    edits.push(withTarget({
      employeeId: edit.employeeId,
      hour: edit.hour,
      shiftId: shift.id,
      expectedShift: {
        startAt: shift.startAt.toISOString(),
        endAt: shift.endAt.toISOString(),
        employeeId: shift.employeeId,
        sourcePosition: shift.sourcePosition,
      },
      expected: current ? { id: current.id, stationId: current.stationId } : null,
    }, edit.target));
    const cell: CellView = {
      employeeId: edit.employeeId,
      name: employee ? `${employee.firstName} ${employee.lastName}` : edit.employeeId,
      hour: edit.hour,
      before: current?.stationId ?? null,
      after: edit.target.kind === "station" ? edit.target.stationId : null,
    };
    if (edit.target.kind === "family") cell.family = edit.target.family;
    cells.push(cell);
  }
  return {
    packet: {
      version: 1,
      release: packet.release,
      board: packet.board,
      date: packet.date,
      agent: packet.agent,
      edits,
    },
    cells,
  };
}

async function confirmResolved(packet: ResolvedPacket): Promise<ResolvedPacket> {
  await requireLegacy(prisma);
  for (const edit of packet.edits) {
    const shift = await prisma.shift.findFirst({
      where: {
        id: edit.shiftId,
        employeeId: edit.employeeId,
        date: packet.date,
        board: packet.board,
        supersededAt: null,
        boardRemoved: false,
      },
    });
    if (
      !shift
      || shift.startAt.toISOString() !== edit.expectedShift.startAt
      || shift.endAt.toISOString() !== edit.expectedShift.endAt
      || shift.employeeId !== edit.expectedShift.employeeId
      || shift.sourcePosition !== edit.expectedShift.sourcePosition
    ) {
      throw new AgentPaintExit(2, AGENT_PAINT_TEXT.stale);
    }
  }
  return packet;
}

function bindFamilyPreview(
  resolved: { packet: ResolvedPacket; cells: CellView[] },
  stations: { shiftId: string; hour: number; stationId: string | null }[] | undefined,
): { packet: ResolvedPacket; cells: CellView[] } {
  const picked = new Map((stations ?? []).map((row) => [`${row.shiftId}|${row.hour}`, row.stationId]));
  const edits: ResolvedEdit[] = [];
  const cells: CellView[] = [];
  for (let index = 0; index < resolved.packet.edits.length; index += 1) {
    const edit = resolved.packet.edits[index]!;
    const cell = resolved.cells[index]!;
    if (!edit.family) {
      edits.push(edit);
      cells.push(cell);
      continue;
    }
    const members = PAINT_FAMILIES[edit.family] as readonly string[];
    const key = `${edit.shiftId}|${edit.hour}`;
    const current = edit.expected && members.includes(edit.expected.stationId) ? edit.expected.stationId : null;
    const stationId = picked.has(key) ? picked.get(key) : current;
    if (typeof stationId !== "string" || !members.includes(stationId)) {
      throw new AgentPaintExit(1, AGENT_PAINT_TEXT.failed);
    }
    edits.push({
      employeeId: edit.employeeId,
      hour: edit.hour,
      shiftId: edit.shiftId,
      expectedShift: edit.expectedShift,
      expected: edit.expected,
      stationId,
    });
    cells.push({ ...cell, family: edit.family, after: stationId });
  }
  return { packet: { ...resolved.packet, edits }, cells };
}

function toPaintRequest(packet: ResolvedPacket): PaintRequest {
  return {
    board: packet.board,
    date: packet.date,
    edits: packet.edits.map((edit): PaintEdit => ({
      shiftId: edit.shiftId,
      hour: edit.hour,
      expectedShift: edit.expectedShift,
      expected: edit.expected,
      stationId: edit.stationId ?? null,
      ...(edit.family ? { family: edit.family } : {}),
    })),
  };
}

function actorFor(agent: string) {
  return { id: `agent:${agent}`, name: `Agente ${agent}`, route: BOARD_CHANGE_ROUTES.agentPaint };
}

async function runPaint(packet: ResolvedPacket, now: Date, dryRun: boolean): Promise<PaintCall> {
  return paintAssignments(toPaintRequest(packet), now, actorFor(packet.agent), { dryRun });
}

function ruleDetail(result: PaintCall): string {
  if (result.ok) return AGENT_PAINT_TEXT.refused;
  switch (result.code) {
    case "STATION_FULL":
    case "PERSON_ALREADY_ASSIGNED":
      return AGENT_PAINT_TEXT.taken;
    case "FORBIDDEN_ABILITY":
      return AGENT_PAINT_TEXT.blocked;
    case "OUT_OF_SHIFT":
      return AGENT_PAINT_TEXT.offShift;
    case "BOARD_CHANGED":
      return AGENT_PAINT_TEXT.stale;
    default:
      return AGENT_PAINT_TEXT.refused;
  }
}

function depsFor(now: Date, overrides?: Partial<AgentPaintDeps>): AgentPaintDeps {
  return {
    readReleaseSha: overrides?.readReleaseSha ?? readInstalledRelease,
    acquireLock: overrides?.acquireLock ?? ((dir) => acquireReleaseLock(dir, process.pid, {}, 0)),
    releaseLock: overrides?.releaseLock ?? ((dir) => releaseReleaseLock(dir, process.pid)),
    resolve: overrides?.resolve ?? confirmResolved,
    validate: overrides?.validate ?? ((packet) => runPaint(packet, now, true)),
    paint: overrides?.paint ?? ((packet) => runPaint(packet, now, false)),
  };
}

async function assertRelease(deps: AgentPaintDeps, appDir: string, release: string): Promise<void> {
  const installed = await deps.readReleaseSha(appDir);
  if (installed !== release) throw new AgentPaintExit(4, AGENT_PAINT_TEXT.release);
}

export function parseAgentPaintArgs(argv: string[]): { mode: "preflight" | "apply"; applySha?: string } {
  if (argv.length === 0 || (argv.length === 1 && argv[0] === "--preflight")) return { mode: "preflight" };
  if (argv.length === 2 && argv[0] === "--apply" && typeof argv[1] === "string" && SHA_TEXT.test(argv[1])) {
    return { mode: "apply", applySha: argv[1] };
  }
  throw new AgentPaintExit(3, AGENT_PAINT_TEXT.packet);
}

export async function runAgentPaint(
  input: { raw: string; mode: "preflight" | "apply"; applySha?: string; appDir: string; now?: Date },
  overrides?: Partial<AgentPaintDeps>,
): Promise<AgentPaintResult> {
  const deps = depsFor(input.now ?? new Date(), overrides);
  try {
    if (input.mode === "preflight") {
      const request = parseRequestPacket(input.raw);
      await assertRelease(deps, input.appDir, request.release);
      const resolved = await resolveRequest(request);
      const validated = await deps.validate(resolved.packet);
      if (!validated.ok) throw new AgentPaintExit(2, ruleDetail(validated));
      const bound = bindFamilyPreview(resolved, validated.stations);
      return {
        code: 0,
        stdout: line({
          mode: "preflight",
          sha256: packetSha256(bound.packet),
          packet: bound.packet,
          cells: bound.cells,
        }),
        stderr: "",
      };
    }
    const packet = parseResolvedPacket(input.raw);
    const sha = packetSha256(packet);
    if (!input.applySha || !SHA_TEXT.test(input.applySha) || sha !== input.applySha) {
      throw new AgentPaintExit(3, AGENT_PAINT_TEXT.sha);
    }
    const locked = await deps.acquireLock(input.appDir);
    if (!locked) throw new AgentPaintExit(1, AGENT_PAINT_TEXT.lock);
    try {
      await assertRelease(deps, input.appDir, packet.release);
      const resolved = await deps.resolve(packet);
      const validated = await deps.validate(resolved);
      if (!validated.ok) throw new AgentPaintExit(2, ruleDetail(validated));
      const painted = await deps.paint(resolved);
      if (!painted.ok) throw new AgentPaintExit(2, ruleDetail(painted));
      return { code: 0, stdout: line({ mode: "apply", sha256: sha, saved: painted.saved }), stderr: "" };
    } finally {
      await deps.releaseLock(input.appDir);
    }
  } catch (error) {
    if (error instanceof AgentPaintExit) return fail(error.exitCode, error.message);
    return fail(1, AGENT_PAINT_TEXT.failed);
  }
}
