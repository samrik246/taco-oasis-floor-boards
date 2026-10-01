import { boardWrite } from "@/lib/shared-write";
import { quarterState } from "@/lib/quarter/schema";
import { assignedIntervals, resolvePaintWorld } from "@/lib/quarter/world";
import { prisma } from "@/lib/db";
import { draftReturnPrompts } from "@/lib/return-to-station";
import { chicagoHourStart } from "@/lib/hour-grid";
import type { FloorBoardId } from "@/lib/board-config";
import { isFloorBoardId } from "@/lib/board-config";
import { tareaTemplateById } from "@/lib/tareas/catalog";

/**
 * When the training switch is on and a load station is Slammed: auto-unassign
 * working tareas for seat assignees + floaters, and create return prompts.
 * A live shift (trainer off) never takes this path — fake meters must not
 * clear tareas or call people back.
 */
export async function processReturnToStation(args: {
  date: string;
  hour: number;
  board?: FloorBoardId;
}): Promise<{ created: number; unassigned: number }> {
  return boardWrite(prisma, async tx => {
  const config = await tx.trafficSimulatorConfig.findUnique({
    where: { id: "default" },
  });
  if (!config?.enabled) {
    return { created: 0, unassigned: 0 };
  }
  const meters = await tx.loadStationMeter.findMany();
  const hourStart = chicagoHourStart(args.date, args.hour);

  const active=(await quarterState(tx))?.phase === "active";
  const now = new Date();
  if(active && (+now<+hourStart || +now>=+hourStart+3600000))return {created:0,unassigned:0};
  const assignments = active ? [] : await tx.assignment.findMany({
    where: { hourStart },
    include: {
      shift: { include: { employee: true } },
      station: true,
    },
  });

  let seatAssignees = assignments
    .filter((a) => {
      if (a.shift.date !== args.date) return false;
      if (!isFloorBoardId(a.shift.board)) return false;
      if (args.board && a.shift.board !== args.board) return false;
      return true;
    })
    .map((a) => ({
      employeeId: a.shift.employeeId,
      seatId: a.stationId,
      displayName: `${a.shift.employee.firstName} ${a.shift.employee.lastName}`.trim(),
    }));

  if(active) {
    const world=await resolvePaintWorld(tx,args.date);
    const rows=assignedIntervals(world).filter(s=>s.startMs<=+now&&s.endMs>+now&&(!args.board||s.board===args.board));
    const employees=await tx.employee.findMany({where:{id:{in:[...new Set(rows.map(s=>s.employeeId))]}},select:{id:true,firstName:true,lastName:true}});
    seatAssignees=rows.map(r=>({employeeId:r.employeeId,seatId:r.stationId!,displayName:employees.filter(e=>e.id===r.employeeId).map(e=>`${e.firstName} ${e.lastName}`.trim())[0]??r.employeeId}));
  }

  const working = await tx.tareaAssignment.findMany({
    where: { date: args.date, status: "working", unassignedAt: null },
    include: { template: true },
  });

  const workingFiltered = args.board
    ? working.filter((t) => {
        const seed = tareaTemplateById(t.templateId);
        return (seed?.board ?? t.template.board) === args.board;
      })
    : working;

  const drafts = draftReturnPrompts({
    meters: meters.map((m) => ({
      loadStationId: m.loadStationId,
      level: m.level as "quiet" | "busy" | "slammed",
    })),
    seatAssignees,
    workingTareas: workingFiltered.map((t) => ({
      id: t.id,
      employeeId: t.employeeId,
      templateLabel: t.template.label,
    })),
    board: args.board,
  });

  let unassigned = 0;

  for (const draft of drafts) {
    if (draft.tareaIds.length) {
      const result = await tx.tareaAssignment.updateMany({
        where: {
          id: { in: draft.tareaIds },
          status: "working",
          unassignedAt: null,
        },
        data: {
          status: "done",
          unassignedAt: now,
          completedAt: now,
        },
      });
      unassigned += result.count;
    }

    const existing = await tx.returnPrompt.findFirst({
      where: {
        date: args.date,
        employeeId: draft.employeeId,
        loadStationId: draft.loadStationId,
        acknowledgedAt: null,
      },
    });
    if (!existing) {
      await tx.returnPrompt.create({
        data: {
          date: args.date,
          employeeId: draft.employeeId,
          loadStationId: draft.loadStationId,
          seatId: draft.seatId,
          message: draft.message,
        },
      });
    }
  }

  return { created: drafts.length, unassigned };
  });
}

export async function listOpenReturnPrompts(date: string) {
  return prisma.returnPrompt.findMany({
    where: { date, acknowledgedAt: null },
    include: {
      employee: { select: { id: true, firstName: true, lastName: true } },
    },
    orderBy: { createdAt: "desc" },
  });
}

export async function acknowledgeReturnPrompt(id: string) {
  return boardWrite(prisma, tx => tx.returnPrompt.update({
    where: { id },
    data: { acknowledgedAt: new Date() },
  }));
}
