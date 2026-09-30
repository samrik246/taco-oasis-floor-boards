import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { loadColumnDefaults } from "@/lib/abilities/column-settings";
import { pickDueCovers, setAfterPickReadForTests } from "@/lib/breaks/auto-pick";
import { firstAutoCover } from "@/lib/breaks/covers";
import { listBreaksNow } from "@/lib/breaks/now";
import { replaceAutoCover } from "@/lib/breaks/manage";
import { saveBreak } from "@/lib/breaks/rules";
import { MANDATORY_STATIONS_BY_BOARD } from "@/lib/mandatory";
import { buildDaySlices, personQuarters, type SlicePaint, type SliceShift } from "@/lib/slices/day-slices";
import { chicagoDateOffset } from "@/lib/date-math";
import { chicagoDateTime } from "@/lib/time";

const date = chicagoDateOffset("2037-04-06", Math.floor(Date.now() % 900));
const prisma = new PrismaClient();
const stamp = `b4pr3p-${Date.now()}`;
const stars = [...MANDATORY_STATIONS_BY_BOARD.cocina];

function at(clock: string, day = date): Date {
  return chicagoDateTime(day, clock);
}

function shift(id: string, start: string, end: string, board = "cocina"): SliceShift {
  return {
    id,
    employeeId: id,
    board,
    startAt: at(start),
    endAt: at(end),
    superseded: false,
    boardRemoved: false,
  };
}

function paint(employeeId: string, stationId: string, clock = "2:00 pm"): SlicePaint {
  return { employeeId, shiftId: employeeId, stationId, hourStart: at(clock) };
}

function names(ids: string[]): Map<string, string> {
  return new Map(ids.map((id) => [id, id[0]!.toUpperCase() + id.slice(1)]));
}

async function seatedDay(input: {
  day?: string;
  end?: string;
  paintAt?: string;
  extras?: { key: string; firstName: string; level: string }[];
}) {
  const day = input.day ?? date;
  const end = input.end ?? "4:00 pm";
  const paintAt = input.paintAt ?? "2:00 pm";
  const seats = await Promise.all(stars.map((stationId, index) => prisma.employee.create({
    data: {
      externalId: `${stamp}-${day}-${stationId}`,
      firstName: index === 0 ? "Ada" : `Seat${index}`,
      lastName: "Moss",
    },
  })));
  const extras = await Promise.all((input.extras ?? []).map((extra) => prisma.employee.create({
    data: { externalId: `${stamp}-${day}-${extra.key}`, firstName: extra.firstName, lastName: "Moss" },
  })));
  const people = [...seats, ...extras];
  const shifts = await Promise.all(people.map((person) => prisma.shift.create({
    data: {
      employeeId: person.id,
      date: day,
      board: "cocina",
      sourcePosition: "Cocina",
      startAt: at("11:00 am", day),
      endAt: at(end, day),
    },
  })));
  await Promise.all(seats.map((person, index) => prisma.assignment.create({
    data: {
      shiftId: shifts[index]!.id,
      employeeId: person.id,
      stationId: stars[index]!,
      hourStart: at(paintAt, day),
      hourEnd: at(paintAt === "5:00 pm" ? "6:00 pm" : "3:00 pm", day),
    },
  })));
  if (extras.length > 0) {
    await prisma.employeeStationAbility.createMany({
      data: extras.map((person, index) => ({
        employeeId: person.id,
        stationId: stars[0]!,
        level: input.extras![index]!.level,
      })),
    });
  }
  return { asker: seats[0]!, seats, extras, shifts };
}

async function autoCoverFor(day: string, employeeId: string) {
  const shifts = await prisma.shift.findMany({
    where: { date: day, supersededAt: null, boardRemoved: false },
    include: { employee: { select: { firstName: true } } },
  });
  const paints = shifts.length === 0
    ? []
    : await prisma.assignment.findMany({
      where: { shiftId: { in: shifts.map((shift) => shift.id) } },
      select: { employeeId: true, shiftId: true, stationId: true, hourStart: true },
    });
  const breakRows = await prisma.staffBreak.findMany({ where: { date: day } });
  const abilities = await prisma.employeeStationAbility.findMany({
    where: { employeeId: { in: shifts.map((shift) => shift.employeeId) } },
    select: { employeeId: true, stationId: true, level: true },
  });
  const defaults = await loadColumnDefaults(prisma);
  return firstAutoCover({
    date: day,
    board: "cocina",
    employeeId,
    startAt: at("2:00 pm", day),
    endAt: at("2:15 pm", day),
    shifts: shifts.map((shift) => ({
      id: shift.id,
      employeeId: shift.employeeId,
      board: shift.board,
      startAt: shift.startAt,
      endAt: shift.endAt,
      superseded: false,
      boardRemoved: false,
    })),
    paints: paints.flatMap((row) => {
      if (!row.employeeId) return [];
      return [{
        employeeId: row.employeeId,
        shiftId: row.shiftId,
        stationId: row.stationId,
        hourStart: row.hourStart,
      }];
    }),
    breaks: breakRows.flatMap((row) => {
      if (row.status !== "booked" && row.status !== "pending") return [];
      if (row.board !== "caja" && row.board !== "cocina") return [];
      return [{
        employeeId: row.employeeId,
        shiftId: row.shiftId,
        board: row.board,
        startAt: row.startAt,
        endAt: row.endAt,
        status: row.status === "booked" ? "booked" as const : "pending" as const,
        coverEmployeeId: row.coverEmployeeId,
        shuffleEmployeeId: row.shuffleEmployeeId,
        auto: row.auto,
      }];
    }),
    starStationIds: stars,
    abilities,
    defaults,
    names: new Map(shifts.map((shift) => [shift.employeeId, shift.employee.firstName])),
  });
}

describe("B4 PR 3 five-minute pick", () => {
  it("names a preferred or ok simple cover and skips training and a Shuffle", () => {
    const base = {
      date,
      board: "cocina" as const,
      employeeId: "ada",
      startAt: at("2:00 pm"),
      endAt: at("2:15 pm"),
      paints: [paint("ada", "pdf_tq1r")],
      breaks: [],
      starStationIds: ["pdf_tq1r"],
      names: names(["ada", "cam", "amy", "dee", "gus", "bea"]),
    };
    const shifts = [
      shift("ada", "11:00 am", "4:00 pm"),
      shift("cam", "11:00 am", "4:00 pm"),
      shift("amy", "11:00 am", "4:00 pm"),
      shift("dee", "11:00 am", "4:00 pm"),
    ];
    expect(firstAutoCover({
      ...base,
      shifts,
      abilities: [
        { employeeId: "cam", stationId: "pdf_tq1r", level: "preferred" },
        { employeeId: "amy", stationId: "pdf_tq1r", level: "ok" },
        { employeeId: "dee", stationId: "pdf_tq1r", level: "training" },
      ],
    })).toEqual({ employeeId: "cam", shiftId: "cam" });
    expect(firstAutoCover({
      ...base,
      shifts: [shift("ada", "11:00 am", "4:00 pm"), shift("dee", "11:00 am", "4:00 pm")],
      names: names(["ada", "dee"]),
      abilities: [{ employeeId: "dee", stationId: "pdf_tq1r", level: "training" }],
    })).toBeNull();
    expect(firstAutoCover({
      ...base,
      names: names(["ada", "gus", "bea"]),
      shifts: [
        shift("ada", "11:00 am", "4:00 pm"),
        shift("gus", "11:00 am", "4:00 pm"),
        shift("bea", "11:00 am", "4:00 pm"),
      ],
      paints: [paint("ada", "pdf_tq1r"), paint("gus", "pdf_tf1r")],
      starStationIds: ["pdf_tq1r", "pdf_tf1r"],
      abilities: [
        { employeeId: "bea", stationId: "pdf_tq1r", level: "forbidden" },
        { employeeId: "gus", stationId: "pdf_tq1r", level: "preferred" },
        { employeeId: "bea", stationId: "pdf_tf1r", level: "ok" },
      ],
    })).toBeNull();
  });

  it("puts BREAK on the resting quarter and auto on the moved quarter", () => {
    const day = buildDaySlices({
      date,
      board: "cocina",
      now: at("2:00 pm"),
      stations: [{ id: "pdf_tq1r" }],
      starStationIds: ["pdf_tq1r"],
      shifts: [shift("ada", "11:00 am", "4:00 pm"), shift("cam", "11:00 am", "4:00 pm")],
      paints: [paint("ada", "pdf_tq1r")],
      breaks: [{
        employeeId: "ada",
        shiftId: "ada",
        board: "cocina",
        startAt: at("2:00 pm"),
        endAt: at("2:15 pm"),
        status: "booked",
        coverEmployeeId: "cam",
        auto: true,
      }],
      overlays: [],
    });
    const ada = personQuarters(day, "ada", 14);
    const cam = personQuarters(day, "cam", 14);
    expect(ada[0]?.kind).toBe("break");
    expect(ada[0]?.auto).toBeUndefined();
    expect(cam[0]).toMatchObject({ kind: "seated", auto: true });
    expect(ada.slice(1).every((quarter) => quarter.kind !== "break")).toBe(true);
  });

  it("picks one preferred cover five minutes before, and a second read does not pick again", async () => {
    const { asker, extras } = await seatedDay({
      extras: [
        { key: "cam", firstName: "Cam", level: "preferred" },
        { key: "amy", firstName: "Amy", level: "ok" },
      ],
    });
    const when = at("1:56 pm");
    await saveBreak({
      employeeId: asker.id,
      date,
      startAt: at("2:00 pm"),
      endAt: at("2:15 pm"),
    });
    setAfterPickReadForTests(async () => {
      setAfterPickReadForTests(null);
      await pickDueCovers(when);
    });
    try {
      await pickDueCovers(when);
    } finally {
      setAfterPickReadForTests(null);
    }
    const row = await prisma.staffBreak.findUniqueOrThrow({
      where: { employeeId_date: { employeeId: asker.id, date } },
    });
    expect(row.status).toBe("booked");
    expect(row.auto).toBe(true);
    expect(row.coverEmployeeId).toBe(extras[0]!.id);
    expect(row.shuffleEmployeeId).toBeNull();
    const listed = await listBreaksNow("cocina", at("1:58 pm"));
    expect(listed.coverTold).toEqual(["Cam cubre a Ada."]);
    expect(listed.rolledEnded).toEqual([]);
    expect(JSON.stringify(listed)).not.toContain(asker.id);

    const owner = await prisma.manager.create({ data: { name: "Synthetic Replacement Owner", codeHash: "synthetic-unused", role: "owner" } });
    const changed = await replaceAutoCover({
      manager: { id: owner.id, name: owner.name, kind: "manager" },
      board: "cocina",
      employeeId: asker.id,
      coverEmployeeId: extras[1]!.id,
      now: when,
    });
    await prisma.manager.delete({ where: { id: owner.id } });
    expect(changed.status).toBe("booked");
    const after = await prisma.staffBreak.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.auto).toBe(false);
    expect(after.coverEmployeeId).toBe(extras[1]!.id);
    expect((await listBreaksNow("cocina", when)).coverTold).toEqual([]);
  });

  it("rolls when the only simple cover is training, and leaves a window already under way", async () => {
    const { asker } = await seatedDay({
      day: chicagoDateOffset(date, 1),
      extras: [{ key: "dee", firstName: "Dee", level: "training" }],
    });
    const day = chicagoDateOffset(date, 1);
    await saveBreak({
      employeeId: asker.id,
      date: day,
      startAt: at("2:00 pm", day),
      endAt: at("2:15 pm", day),
    });
    await pickDueCovers(at("1:56 pm", day));
    const rolled = await prisma.staffBreak.findUniqueOrThrow({
      where: { employeeId_date: { employeeId: asker.id, date: day } },
    });
    expect(rolled.status).toBe("pending");
    expect(rolled.auto).toBe(false);
    expect(rolled.coverEmployeeId).toBeNull();
    expect(rolled.startAt.toISOString()).toBe(at("2:15 pm", day).toISOString());
    expect(rolled.endAt.toISOString()).toBe(at("2:30 pm", day).toISOString());

    await pickDueCovers(at("2:15 pm", day));
    const late = await prisma.staffBreak.findUniqueOrThrow({ where: { id: rolled.id } });
    expect(late.startAt.toISOString()).toBe(rolled.startAt.toISOString());
    expect(late.status).toBe("pending");
    expect(late.coverEmployeeId).toBeNull();
  });

  it("does not pick six minutes early", async () => {
    const day = chicagoDateOffset(date, 2);
    const { asker, extras } = await seatedDay({
      day,
      extras: [{ key: "cam", firstName: "Cam", level: "preferred" }],
    });
    await saveBreak({
      employeeId: asker.id,
      date: day,
      startAt: at("2:00 pm", day),
      endAt: at("2:15 pm", day),
    });
    const tally = await pickDueCovers(at("1:54 pm", day));
    expect(tally).toEqual({ picked: 0, rolled: 0, ended: 0 });
    const row = await prisma.staffBreak.findUniqueOrThrow({
      where: { employeeId_date: { employeeId: asker.id, date: day } },
    });
    expect(row.status).toBe("pending");
    expect(row.coverEmployeeId).toBeNull();
    expect(extras[0]).toBeTruthy();
  });

  it("ends the break when the next quarter no longer fits, and the tablet says so", async () => {
    const day = chicagoDateOffset(date, 3);
    const { asker } = await seatedDay({ day, end: "7:00 pm", paintAt: "5:00 pm" });
    await saveBreak({
      employeeId: asker.id,
      date: day,
      startAt: at("5:45 pm", day),
      endAt: at("6:00 pm", day),
    });
    const tally = await pickDueCovers(at("5:41 pm", day));
    expect(tally.ended).toBe(1);
    const row = await prisma.staffBreak.findUniqueOrThrow({
      where: { employeeId_date: { employeeId: asker.id, date: day } },
    });
    expect(row.status).toBe("ended");
    expect(row.coverEmployeeId).toBeNull();
    const listed = await listBreaksNow("cocina", at("5:41 pm", day));
    expect(listed.rolledEnded).toEqual(["El descanso de Ada ya no cabe."]);
    expect(listed.now.map((item) => item.firstName)).not.toContain("Ada");
  });

  it("gives the only cover to the earlier queued break", async () => {
    const day = chicagoDateOffset(date, 4);
    const first = await seatedDay({
      day,
      extras: [{ key: "cam", firstName: "Cam", level: "preferred" }],
    });
    const secondAsker = first.seats[1]!;
    await saveBreak({
      employeeId: first.asker.id,
      date: day,
      startAt: at("2:00 pm", day),
      endAt: at("2:15 pm", day),
    });
    await saveBreak({
      employeeId: secondAsker.id,
      date: day,
      startAt: at("2:00 pm", day),
      endAt: at("2:15 pm", day),
    });
    const pending = await prisma.staffBreak.findMany({
      where: { date: day, status: "pending" },
      orderBy: { id: "asc" },
    });
    expect(pending).toHaveLength(2);
    await pickDueCovers(at("1:56 pm", day));
    const winner = await prisma.staffBreak.findUniqueOrThrow({ where: { id: pending[0]!.id } });
    const other = await prisma.staffBreak.findUniqueOrThrow({ where: { id: pending[1]!.id } });
    expect(winner.status).toBe("booked");
    expect(winner.auto).toBe(true);
    expect(winner.coverEmployeeId).toBe(first.extras[0]!.id);
    expect(other.status).toBe("pending");
    expect(other.coverEmployeeId).toBeNull();
    expect(other.startAt.toISOString()).toBe(at("2:15 pm", day).toISOString());
  });

  it("rolls a pending star when two breaks already book the quarter", async () => {
    const day = chicagoDateOffset(date, 5);
    const { asker, extras } = await seatedDay({
      day,
      extras: [
        { key: "cam", firstName: "Cam", level: "preferred" },
        { key: "bea", firstName: "Bea", level: "ok" },
        { key: "gus", firstName: "Gus", level: "ok" },
      ],
    });
    const waiting = await saveBreak({
      employeeId: asker.id,
      date: day,
      startAt: at("2:00 pm", day),
      endAt: at("2:15 pm", day),
    });
    expect(waiting.status).toBe("pending");
    const booked = [];
    for (const person of [extras[1]!, extras[2]!]) {
      booked.push(await saveBreak({
        employeeId: person.id,
        date: day,
        startAt: at("2:00 pm", day),
        endAt: at("2:15 pm", day),
      }));
    }
    expect(booked.map((row) => row.status)).toEqual(["booked", "booked"]);
    expect(await autoCoverFor(day, asker.id)).toMatchObject({ employeeId: extras[0]!.id });

    const tally = await pickDueCovers(at("1:56 pm", day));
    expect(tally).toEqual({ picked: 0, rolled: 1, ended: 0 });
    const row = await prisma.staffBreak.findUniqueOrThrow({
      where: { employeeId_date: { employeeId: asker.id, date: day } },
    });
    expect(row.status).toBe("pending");
    expect(row.auto).toBe(false);
    expect(row.coverEmployeeId).toBeNull();
    expect(row.startAt.toISOString()).toBe(at("2:15 pm", day).toISOString());
    expect(row.endAt.toISOString()).toBe(at("2:30 pm", day).toISOString());
    expect(await prisma.staffBreak.count({ where: { date: day, status: "booked" } })).toBe(2);
  });

  it("books a named pending row on the next wake after a full ceiling, and ends one at the shift edge", async () => {
    const day = chicagoDateOffset(date, 6);
    const { asker, extras, shifts } = await seatedDay({
      day,
      paintAt: "1:00 pm",
      extras: [
        { key: "cam", firstName: "Cam", level: "preferred" },
        { key: "bea", firstName: "Bea", level: "ok" },
        { key: "gus", firstName: "Gus", level: "ok" },
      ],
    });
    const waiting = await saveBreak({
      employeeId: asker.id,
      date: day,
      startAt: at("1:15 pm", day),
      endAt: at("1:30 pm", day),
    });
    expect(waiting.status).toBe("pending");
    const coverShift = shifts.find((shift) => shift.employeeId === extras[0]!.id);
    await prisma.staffBreak.update({
      where: { id: waiting.id },
      data: { coverEmployeeId: extras[0]!.id, coverShiftId: coverShift!.id },
    });
    for (const person of [extras[1]!, extras[2]!]) {
      const booked = await saveBreak({
        employeeId: person.id,
        date: day,
        startAt: at("1:15 pm", day),
        endAt: at("1:30 pm", day),
      });
      expect(booked.status).toBe("booked");
    }

    const rolledTally = await pickDueCovers(at("1:10 pm", day));
    expect(rolledTally).toEqual({ picked: 0, rolled: 1, ended: 0 });
    const rolled = await prisma.staffBreak.findUniqueOrThrow({ where: { id: waiting.id } });
    expect(rolled.status).toBe("pending");
    expect(rolled.coverEmployeeId).toBe(extras[0]!.id);
    expect(rolled.startAt.toISOString()).toBe(at("1:30 pm", day).toISOString());
    expect(rolled.endAt.toISOString()).toBe(at("1:45 pm", day).toISOString());

    const bookedTally = await pickDueCovers(at("1:25 pm", day));
    expect(bookedTally).toEqual({ picked: 1, rolled: 0, ended: 0 });
    const booked = await prisma.staffBreak.findUniqueOrThrow({ where: { id: waiting.id } });
    expect(booked.status).toBe("booked");
    expect(booked.auto).toBe(false);
    expect(booked.coverEmployeeId).toBe(extras[0]!.id);
    expect(booked.startAt.toISOString()).toBe(at("1:30 pm", day).toISOString());

    const edge = chicagoDateOffset(date, 7);
    const ending = await seatedDay({
      day: edge,
      end: "7:00 pm",
      paintAt: "5:00 pm",
      extras: [
        { key: "cam", firstName: "Cam", level: "preferred" },
        { key: "bea", firstName: "Bea", level: "ok" },
        { key: "gus", firstName: "Gus", level: "ok" },
      ],
    });
    const last = await saveBreak({
      employeeId: ending.asker.id,
      date: edge,
      startAt: at("5:45 pm", edge),
      endAt: at("6:00 pm", edge),
    });
    const endingCover = ending.shifts.find((shift) => shift.employeeId === ending.extras[0]!.id);
    await prisma.staffBreak.update({
      where: { id: last.id },
      data: { coverEmployeeId: ending.extras[0]!.id, coverShiftId: endingCover!.id },
    });
    for (const person of [ending.extras[1]!, ending.extras[2]!]) {
      await saveBreak({
        employeeId: person.id,
        date: edge,
        startAt: at("5:45 pm", edge),
        endAt: at("6:00 pm", edge),
      });
    }
    const endedTally = await pickDueCovers(at("5:41 pm", edge));
    expect(endedTally.ended).toBe(1);
    const ended = await prisma.staffBreak.findUniqueOrThrow({ where: { id: last.id } });
    expect(ended.status).toBe("ended");
    const listed = await listBreaksNow("cocina", at("5:41 pm", edge));
    expect(listed.rolledEnded).toEqual(["El descanso de Ada ya no cabe."]);
  });

  it("starts the pick timer only from the Node runtime", () => {
    const source = readFileSync(path.join(process.cwd(), "src/instrumentation.ts"), "utf8");
    expect(source).toContain('process.env.NEXT_RUNTIME !== "nodejs"');
    expect(source).toContain("startBreakPickTimer");
  });
});
