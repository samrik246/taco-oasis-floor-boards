import { prisma } from "@/lib/db";
import { draftReturnPrompts } from "@/lib/return-to-station";
import type { LoadStationId } from "@/lib/load-stations";
import { chicagoHourStart } from "@/lib/hour-grid";

/**
 * When load stations are Slammed: auto-unassign working tareas for seat
 * assignees + MULTI, and create return prompts.
 */
export async function processReturnToStation(args: {
  date: string;
  hour: number;
}): Promise<{ created: number; unassigned: number }> {
  const meters = await prisma.loadStationMeter.findMany();
  const hourStart = chicagoHourStart(args.date, args.hour);

  const assignments = await prisma.assignment.findMany({
    where: { hourStart },
    include: {
      shift: { include: { employee: true } },
      station: true,
    },
  });

  const seatAssignees = assignments
    .filter((a) => a.shift.date === args.date && a.shift.board === "caja")
    .map((a) => ({
      employeeId: a.shift.employeeId,
      seatId: a.stationId,
      displayName: `${a.shift.employee.firstName} ${a.shift.employee.lastName}`.trim(),
    }));

  const working = await prisma.tareaAssignment.findMany({
    where: { date: args.date, status: "working", unassignedAt: null },
    include: { template: true },
  });

  const drafts = draftReturnPrompts({
    meters: meters.map((m) => ({
      loadStationId: m.loadStationId as LoadStationId,
      level: m.level as "quiet" | "busy" | "slammed",
    })),
    seatAssignees,
    workingTareas: working.map((t) => ({
      id: t.id,
      employeeId: t.employeeId,
      templateLabel: t.template.label,
    })),
  });

  let unassigned = 0;
  const now = new Date();

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

    // Avoid duplicate open prompts for same employee+load today
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
    }
  }

  return { created: drafts.length, unassigned };
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
