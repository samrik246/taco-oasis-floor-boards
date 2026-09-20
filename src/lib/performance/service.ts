import { prisma } from "@/lib/db";
import type { FloorBoardId } from "@/lib/board-config";
import {
  DEFAULT_PERFORMANCE_QUESTIONS,
  isValidAnswerForQuestion,
} from "@/lib/performance/questions";

export type PerformanceAnswersMap = Record<string, string>;

export async function listPerformanceQuestions() {
  return DEFAULT_PERFORMANCE_QUESTIONS;
}

export async function getPerformanceAnswer(args: {
  date: string;
  board: FloorBoardId;
  employeeId: string;
}) {
  return prisma.performanceAnswer.findUnique({
    where: {
      date_board_employeeId: {
        date: args.date,
        board: args.board,
        employeeId: args.employeeId,
      },
    },
    include: {
      employee: {
        select: { id: true, firstName: true, lastName: true, externalId: true },
      },
    },
  });
}

export async function listPerformanceAnswers(args: {
  date: string;
  board: FloorBoardId;
}) {
  return prisma.performanceAnswer.findMany({
    where: { date: args.date, board: args.board },
    include: {
      employee: {
        select: { id: true, firstName: true, lastName: true, externalId: true },
      },
    },
    orderBy: { updatedAt: "desc" },
  });
}

export type UpsertPerformanceResult =
  | { ok: true; record: Awaited<ReturnType<typeof getPerformanceAnswer>> }
  | { ok: false; status: 404 | 422; error: string };

export async function upsertPerformanceAnswer(args: {
  date: string;
  board: FloorBoardId;
  employeeId: string;
  answers: PerformanceAnswersMap;
}): Promise<UpsertPerformanceResult> {
  const employee = await prisma.employee.findUnique({
    where: { id: args.employeeId },
  });
  if (!employee) {
    return { ok: false, status: 404, error: "Employee not found" };
  }

  for (const [qid, value] of Object.entries(args.answers)) {
    const q = DEFAULT_PERFORMANCE_QUESTIONS.find((x) => x.id === qid);
    if (!q) {
      return { ok: false, status: 422, error: `Unknown question: ${qid}` };
    }
    if (q.required && (!value || !String(value).trim())) {
      return { ok: false, status: 422, error: `Required: ${q.prompt}` };
    }
    if (value && !isValidAnswerForQuestion(qid, value) && q.answerType !== "free_note") {
      return {
        ok: false,
        status: 422,
        error: `Invalid answer for ${qid}: ${value}`,
      };
    }
  }

  for (const q of DEFAULT_PERFORMANCE_QUESTIONS) {
    if (q.required && !(q.id in args.answers)) {
      return { ok: false, status: 422, error: `Missing required: ${q.id}` };
    }
  }

  const answersJson = JSON.stringify(args.answers);
  const record = await prisma.performanceAnswer.upsert({
    where: {
      date_board_employeeId: {
        date: args.date,
        board: args.board,
        employeeId: args.employeeId,
      },
    },
    create: {
      date: args.date,
      board: args.board,
      employeeId: args.employeeId,
      answersJson,
    },
    update: { answersJson },
    include: {
      employee: {
        select: { id: true, firstName: true, lastName: true, externalId: true },
      },
    },
  });

  return { ok: true, record };
}
