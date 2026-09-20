import { prisma } from "@/lib/db";
import { DEFAULT_PERFORMANCE_QUESTIONS } from "@/lib/performance/questions";
import type { FloorBoardId } from "@/lib/board-config";

export async function ensurePerformanceQuestions() {
  for (const q of DEFAULT_PERFORMANCE_QUESTIONS) {
    await prisma.performanceQuestion.upsert({
      where: { id: q.id },
      create: {
        id: q.id,
        prompt: q.prompt,
        kind: q.kind,
        sortOrder: q.sortOrder,
        active: true,
      },
      update: {
        prompt: q.prompt,
        kind: q.kind,
        sortOrder: q.sortOrder,
        active: true,
      },
    });
  }
}

export async function listPerformanceQuestions() {
  await ensurePerformanceQuestions();
  return prisma.performanceQuestion.findMany({
    where: { active: true },
    orderBy: { sortOrder: "asc" },
  });
}

export async function listPerformanceAnswers(args: {
  date: string;
  board: FloorBoardId;
  employeeId?: string;
}) {
  await ensurePerformanceQuestions();
  return prisma.performanceAnswer.findMany({
    where: {
      date: args.date,
      board: args.board,
      ...(args.employeeId ? { employeeId: args.employeeId } : {}),
    },
    include: { question: true },
    orderBy: { question: { sortOrder: "asc" } },
  });
}

export async function upsertPerformanceAnswers(args: {
  date: string;
  board: FloorBoardId;
  employeeId: string;
  answers: { questionId: string; value: string }[];
}) {
  await ensurePerformanceQuestions();

  const employee = await prisma.employee.findUnique({
    where: { id: args.employeeId },
  });
  if (!employee) {
    return { ok: false as const, status: 404 as const, error: "Employee not found" };
  }

  for (const a of args.answers) {
    const q = await prisma.performanceQuestion.findUnique({
      where: { id: a.questionId },
    });
    if (!q) {
      return {
        ok: false as const,
        status: 404 as const,
        error: `Question not found: ${a.questionId}`,
      };
    }
    await prisma.performanceAnswer.upsert({
      where: {
        date_board_employeeId_questionId: {
          date: args.date,
          board: args.board,
          employeeId: args.employeeId,
          questionId: a.questionId,
        },
      },
      create: {
        date: args.date,
        board: args.board,
        employeeId: args.employeeId,
        questionId: a.questionId,
        value: a.value,
      },
      update: { value: a.value },
    });
  }

  const saved = await listPerformanceAnswers({
    date: args.date,
    board: args.board,
    employeeId: args.employeeId,
  });
  return { ok: true as const, answers: saved };
}
