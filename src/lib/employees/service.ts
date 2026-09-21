import { prisma } from "@/lib/db";
import type { AbilityLevel } from "@/lib/rules/types";

const ABILITY_LEVELS = ["forbidden", "training", "ok", "preferred"] as const;

export function isAbilityLevel(v: string): v is AbilityLevel {
  return (ABILITY_LEVELS as readonly string[]).includes(v);
}

async function knownStationIds(): Promise<Set<string>> {
  const rows = await prisma.station.findMany({ select: { id: true } });
  return new Set(rows.map((row) => row.id));
}

export async function listEmployees() {
  return prisma.employee.findMany({
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
    include: {
      abilities: true,
    },
  });
}

export async function getEmployee(id: string) {
  return prisma.employee.findUnique({
    where: { id },
    include: { abilities: true },
  });
}

export type CreateEmployeeInput = {
  firstName: string;
  lastName: string;
  externalId?: string;
  email?: string | null;
  abilities?: { stationId: string; level: AbilityLevel }[];
};

export async function createEmployee(input: CreateEmployeeInput) {
  const externalId =
    input.externalId?.trim() ||
    `manual-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const existing = await prisma.employee.findUnique({
    where: { externalId },
  });
  if (existing) {
    return {
      ok: false as const,
      status: 422 as const,
      error: "externalId already exists",
    };
  }

  const stationIds = await knownStationIds();
  const abilities = input.abilities ?? [];
  for (const ability of abilities) {
    if (!stationIds.has(ability.stationId)) {
      return {
        ok: false as const,
        status: 422 as const,
        error: `Unknown station: ${ability.stationId}`,
      };
    }
  }

  const employee = await prisma.employee.create({
    data: {
      externalId,
      firstName: input.firstName.trim(),
      lastName: input.lastName.trim(),
      email: input.email?.trim() || null,
      abilities: {
        create: abilities.map((a) => ({
          stationId: a.stationId,
          level: a.level,
        })),
      },
    },
    include: { abilities: true },
  });

  return { ok: true as const, employee };
}

export type UpdateEmployeeInput = {
  firstName?: string;
  lastName?: string;
  email?: string | null;
  abilities?: { stationId: string; level: AbilityLevel }[];
};

export async function updateEmployee(id: string, input: UpdateEmployeeInput) {
  const existing = await prisma.employee.findUnique({ where: { id } });
  if (!existing) {
    return { ok: false as const, status: 404 as const, error: "Not found" };
  }

  const stationIds = await knownStationIds();

  if (input.abilities) {
    const seen = new Set<string>();
    for (const a of input.abilities) {
      if (seen.has(a.stationId)) {
        return {
          ok: false as const,
          status: 422 as const,
          error: `Ability for ${a.stationId} is listed twice`,
        };
      }
      seen.add(a.stationId);
      if (!stationIds.has(a.stationId) || !isAbilityLevel(a.level)) {
        return {
          ok: false as const,
          status: 422 as const,
          error: `Invalid ability: ${a.stationId}/${a.level}`,
        };
      }
    }
    await prisma.employeeStationAbility.deleteMany({
      where: { employeeId: id },
    });
    await prisma.employeeStationAbility.createMany({
      data: input.abilities.map((a) => ({
        employeeId: id,
        stationId: a.stationId,
        level: a.level,
      })),
    });
  }

  const employee = await prisma.employee.update({
    where: { id },
    data: {
      ...(input.firstName != null
        ? { firstName: input.firstName.trim() }
        : {}),
      ...(input.lastName != null ? { lastName: input.lastName.trim() } : {}),
      ...(input.email !== undefined
        ? { email: input.email?.trim() || null }
        : {}),
    },
    include: { abilities: true },
  });

  return { ok: true as const, employee };
}
