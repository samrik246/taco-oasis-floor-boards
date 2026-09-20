import { prisma } from "@/lib/db";
import { draftReturnPrompts } from "@/lib/return-to-station";
import { chicagoHourStart } from "@/lib/hour-grid";
import type { FloorBoardId } from "@/lib/board-config";
import { boardForTemplate } from "@/lib/tareas/catalog";

/**
 * When load stations are Slammed: auto-unassign working tareas for seat
 * assignees + MULTI (Cashiers), and create return prompts.
 */
export async function processReturnToStation(args: {
  date: string;
  hour: number;
  board?: FloorBoardId;
}): Promise<{ created: number; unassigned: number }> {
  const meters = await prisma.loadStationMeter.findMany();
  const hourStart = chicagoHourStart(args.date, args.hour);
  const boardFilter = args.board;

  const assignments = await prisma.assignment.findMany({
    where: { hourStart },
    include: {
      shift: { include: { employee: true } },
      station: true,
    },
  });

  const seatAssignees = assignments
    .filter(
      (a) =>
        a.shift.date === args.date &&
        (boardFilter == null || a.shift.board === boardFilter) &&
        (a.shift.board === "caja" || a.shift.board === "cocina"),
    )
    .map((a) => ({
      employeeId: a.shift.employeeId,
      seatId: a.stationId,
      displayName: `${a.shift.employee.firstName} ${a.shift.employee.lastName}`.trim(),
    }));

  const working = await prisma.tareaAssignment.findMany({
    where: { date: args.date, status: "working", unassignedAt: null },
    include: { template: true },
  });

  const workingFiltered =
    boardFilter == null
      ? working
      : working.filter((t) => {
          const b =
            (t.template as { board?: string }).board ??
            boardForTemplate(t.templateId);
          return b === boardFilter;
        });

  // Run per board so MULTI only applies on caja
  const boards: FloorBoardId[] =
    boardFilter != null
      ? [boardFilter]
      : (["caja", "cocina"] as FloorBoardId[]);

  let unassigned = 0;
  let created = 0;
  const now = new Date();

  for (const board of boards) {
    const boardAssignees = seatAssignees.filter((a) => {
      const seatBoard = assignments.find(
        (x) =>
          x.shift.employeeId === a.employeeId && x.stationId === a.seatId,
      )?.shift.board;
      return seatBoard === board;
    });

    const boardWorking = workingFiltered.filter((t) => {
      const b =
        (t.template as { board?: string }).board ??
        boardForTemplate(t.templateId);
      return b === board || (b == null && board === "caja");
    });

    const drafts = draftReturnPrompts({
      meters: meters.map((m) => ({
        loadStationId: m.loadStationId,
        level: m.level as "quiet" | "busy" | "slammed",
      })),
      seatAssignees: boardAssignees,
      workingTareas: boardWorking.map((t) => ({
        id: t.id,
        employeeId: t.employeeId,
        templateLabel: t.template.label,
      })),
      board,
    });

    for (const draft of drafts) {
      if (draft.tareaIds.length) {
        const result = await prisma.tareaAssignment.updateMany({
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

      const existing = await prisma.returnPrompt.findFirst({
        where: {
          date: args.date,
          employeeId: draft.employeeId,
          loadStationId: draft.loadStationId,
          acknowledgedAt: null,
        },
      });
      if (!existing) {
        await prisma.returnPrompt.create({
          data: {
            date: args.date,
            employeeId: draft.employeeId,
            loadStationId: draft.loadStationId,
            seatId: draft.seatId,
            message: draft.message,
          },
        });
        created += 1;
      }
    }
  }

  return { created, unassigned };
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
  return prisma.returnPrompt.update({
    where: { id },
    data: { acknowledgedAt: new Date() },
  });
}
