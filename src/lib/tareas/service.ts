import { boardWrite } from "@/lib/shared-write";
import { QuarterRefused, quarterState, worldRevision } from "@/lib/quarter/schema";
import { assignedIntervals, resolvePaintWorld, overlaps } from "@/lib/quarter/world";
import { prisma } from "@/lib/db";
import {
  isLemonWarnTemplate,
  GREEN_SEAT_IDS,
} from "@/lib/tareas/catalog";
import { allTareaTemplates, type FloorBoardId } from "@/lib/board-config";
import { getBoardConfig } from "@/lib/board-config";
import {
  positionFitFromSource,
  suggestAssignees,
  type SuggestionCandidate,
  type SuggestionSlot,
} from "@/lib/suggestions";
import { chicagoHourEnd, chicagoHourStart } from "@/lib/hour-grid";
import { isHourInShift } from "@/lib/rules/shift-window";
import type { AbilityLevel } from "@/lib/rules/types";

export async function ensureTareaTemplates() {
  for (const t of allTareaTemplates()) {
    await prisma.tareaTemplate.upsert({
      where: { id: t.id },
      create: {
        id: t.id,
        code: t.code,
        label: t.label,
        mode: t.mode,
        sortOrder: t.sortOrder,
        board: t.board,
        lemonWarnOnGreens: t.lemonWarnOnGreens === true,
      },
      update: {
        code: t.code,
        label: t.label,
        mode: t.mode,
        sortOrder: t.sortOrder,
        board: t.board,
        lemonWarnOnGreens: t.lemonWarnOnGreens === true,
      },
    });
  }
}

export async function listTareaTemplates(board?: FloorBoardId) {
  await ensureTareaTemplates();
  return prisma.tareaTemplate.findMany({
    where: board ? { board } : undefined,
    orderBy: { sortOrder: "asc" },
  });
}

export async function listTareaAssignments(
  date: string,
  board?: FloorBoardId,
) {
  await ensureTareaTemplates();
  return prisma.tareaAssignment.findMany({
    where: {
      date,
      unassignedAt: null,
      ...(board ? { template: { board } } : {}),
    },
    include: {
      template: true,
      employee: {
        select: { id: true, firstName: true, lastName: true },
      },
    },
    orderBy: [{ status: "asc" }, { assignedAt: "desc" }],
  });
}

export type AssignTareaResult =
  | {
      ok: true;
      assignment: Awaited<ReturnType<typeof listTareaAssignments>>[number];
      lemonWarning?: string;
    }
  | {
      ok: false;
      status: 404 | 422;
      error: string;
      code?: string;
      lemonWarning?: string;
    };

export async function assignTarea(args: {
  date: string;
  employeeId: string;
  templateId: string;
  hour: number;
  forceLemon?: boolean;
  interval?: {startAt:string;endAt:string;databaseEpoch:string;worldRevision:string};
}): Promise<AssignTareaResult> {
  await ensureTareaTemplates();

  return boardWrite(prisma, async tx => {
  const employee = await tx.employee.findUnique({
    where: { id: args.employeeId },
  });
  if (!employee) {
    return { ok: false, status: 404, error: "Employee not found" };
  }

  const template = await tx.tareaTemplate.findUnique({
    where: { id: args.templateId },
  });
  if (!template) {
    return { ok: false, status: 404, error: "Tarea template not found" };
  }

  const hourStart = chicagoHourStart(args.date, args.hour);
  const schema=await quarterState(tx);
  let seat: {stationId:string}|null;
  if(schema?.phase === "active") {
    const interval=args.interval;
    if(!interval || interval.databaseEpoch!==schema.databaseEpoch || interval.worldRevision!==await worldRevision(tx)) throw new QuarterRefused("REVISION_CONFLICT");
    const startMs=+new Date(interval.startAt),endMs=+new Date(interval.endAt);
    if(!Number.isFinite(startMs)||!Number.isFinite(endMs)||startMs<+hourStart||endMs>+hourStart+3600000||endMs<=startMs)throw new QuarterRefused("INVALID_INTERVAL",422);
    const rows=assignedIntervals(await resolvePaintWorld(tx,args.date)).filter(s=>s.employeeId===args.employeeId && overlaps(s,{startMs,endMs}));
    const stations=new Set(rows.map(s=>s.stationId));
    if(stations.size>1)throw new QuarterRefused("HOUR_NEEDS_QUARTER");
    seat=rows[0]?{stationId:rows[0].stationId!}:null;
  } else seat = await tx.assignment.findFirst({
    where: {
      hourStart,
      shift: { employeeId: args.employeeId, date: args.date },
    },
  });

  let lemonWarning: string | undefined;
  const lemonSeats =
    template.board === "caja"
      ? getBoardConfig("caja").rules.lemonWarnSeatIds
      : [];
  if (
    isLemonWarnTemplate(args.templateId) &&
    seat &&
    (lemonSeats.includes(seat.stationId) ||
      GREEN_SEAT_IDS.includes(
        seat.stationId as (typeof GREEN_SEAT_IDS)[number],
      ))
  ) {
    lemonWarning =
      "LEMON on Green/cliente — usually keep greens on customers. Manager can force.";
    if (!args.forceLemon) {
      return {
        ok: false,
        status: 422,
        error: lemonWarning,
        code: "LEMON_WARN_GREENS",
        lemonWarning,
      };
    }
  }

  const created = await tx.tareaAssignment.create({
    data: {
      date: args.date,
      employeeId: args.employeeId,
      templateId: args.templateId,
      status: "working",
      forceLemon: args.forceLemon === true,
    },
    include: {
      template: true,
      employee: {
        select: { id: true, firstName: true, lastName: true },
      },
    },
  });

  return { ok: true, assignment: created, lemonWarning };
  });
}

export async function setTareaStatus(args: {
  id: string;
  status: "working" | "done";
}) {
  return boardWrite(prisma, async tx => {
  const existing = await tx.tareaAssignment.findUnique({
    where: { id: args.id },
  });
  if (!existing) return null;
  return tx.tareaAssignment.update({
    where: { id: args.id },
    data: {
      status: args.status,
      completedAt: args.status === "done" ? new Date() : null,
    },
    include: {
      template: true,
      employee: {
        select: { id: true, firstName: true, lastName: true },
      },
    },
  });
  });
}

export async function buildTareaSuggestions(args: {
  date: string;
  hour: number;
  templateId: string;
  forceLemon?: boolean;
  board?: FloorBoardId;
}): Promise<SuggestionSlot[]> {
  await ensureTareaTemplates();
  if ((await quarterState(prisma))?.phase === "active") throw new QuarterRefused("CLIENT_UPGRADE_REQUIRED",426);
  const hourStart = chicagoHourStart(args.date, args.hour);

  const template = await prisma.tareaTemplate.findUnique({
    where: { id: args.templateId },
  });
  const board: FloorBoardId =
    args.board ??
    (template?.board === "cocina" ? "cocina" : "caja");

  const hourEnd = chicagoHourEnd(args.date, args.hour);
  // Coarse DB window, then the one overlap rule (C1): a :30 starter is on shift.
  const shifts = (
    await prisma.shift.findMany({
      where: {
        board,
        date: args.date,
        supersededAt: null,
        boardRemoved: false,
        startAt: { lt: hourEnd },
        endAt: { gt: hourStart },
      },
      include: {
        employee: { include: { abilities: true } },
        assignments: { where: { hourStart } },
      },
    })
  ).filter((sh) => isHourInShift(hourStart, sh.startAt, sh.endAt, hourEnd));

  const workingCounts = await prisma.tareaAssignment.groupBy({
    by: ["employeeId"],
    where: {
      date: args.date,
      status: "working",
      unassignedAt: null,
      template: { board },
    },
    _count: { _all: true },
  });
  const countMap = Object.fromEntries(
    workingCounts.map((w) => [w.employeeId, w._count._all]),
  );

  const defaultSeat =
    board === "cocina" ? "pdf_tq1r" : "green1";

  const candidates: SuggestionCandidate[] = shifts.map((sh) => {
    const seatId = sh.assignments[0]?.stationId ?? null;
    const ability =
      sh.employee.abilities.find((a) => a.stationId === (seatId ?? defaultSeat))
        ?.level ?? null;
    return {
      employeeId: sh.employee.id,
      displayName: `${sh.employee.firstName} ${sh.employee.lastName}`.trim(),
      seatId,
      abilityLevel: ability as AbilityLevel | null,
      positionFit: positionFitFromSource(sh.sourcePosition),
      activeTareaCount: countMap[sh.employee.id] ?? 0,
    };
  });

  return suggestAssignees({
    templateId: args.templateId,
    candidates,
    forceLemonOnGreens: args.forceLemon === true,
  });
}
