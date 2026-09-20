import { prisma } from "@/lib/db";
import { TIMEZONE } from "@/lib/constants";
import type { ManagerNoteDto } from "@/lib/notes-types";

export type { ManagerNoteDto };
export const NOTE_AUTHOR = "Manager" as const;

function formatChicagoTimestamp(d: Date): string {
  return d.toLocaleString("en-US", {
    timeZone: TIMEZONE,
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function toDto(n: {
  id: string;
  board: string;
  date: string;
  body: string;
  author: string;
  createdAt: Date;
  updatedAt: Date;
}): ManagerNoteDto {
  return {
    id: n.id,
    board: n.board as "caja" | "cocina",
    date: n.date,
    body: n.body,
    author: n.author,
    createdAt: n.createdAt.toISOString(),
    updatedAt: n.updatedAt.toISOString(),
    chicagoTimestamp: formatChicagoTimestamp(n.updatedAt),
  };
}

export async function listNotes(
  board: "caja" | "cocina",
  date: string,
): Promise<ManagerNoteDto[]> {
  const rows = await prisma.managerNote.findMany({
    where: { board, date },
    orderBy: { updatedAt: "desc" },
  });
  return rows.map(toDto);
}

export async function createNote(input: {
  board: "caja" | "cocina";
  date: string;
  body: string;
}): Promise<ManagerNoteDto> {
  const body = input.body.trim();
  if (!body) {
    throw new Error("Note body cannot be empty");
  }
  const row = await prisma.managerNote.create({
    data: {
      board: input.board,
      date: input.date,
      body,
      author: NOTE_AUTHOR,
    },
  });
  return toDto(row);
}

export async function updateNote(
  id: string,
  body: string,
): Promise<ManagerNoteDto | null> {
  const trimmed = body.trim();
  if (!trimmed) {
    throw new Error("Note body cannot be empty");
  }
  const existing = await prisma.managerNote.findUnique({ where: { id } });
  if (!existing) return null;
  const row = await prisma.managerNote.update({
    where: { id },
    data: { body: trimmed, author: NOTE_AUTHOR },
  });
  return toDto(row);
}

export async function deleteNote(id: string): Promise<boolean> {
  const existing = await prisma.managerNote.findUnique({ where: { id } });
  if (!existing) return false;
  await prisma.managerNote.delete({ where: { id } });
  return true;
}
