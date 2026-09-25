import { prisma } from "@/lib/db";
import type { AbilityLevel } from "@/lib/rules/types";

export type ToggleFavoriteResult =
  | { ok: true; level: AbilityLevel }
  | { ok: false; status: 404; error: string };

/**
 * Planner H — the favorite star. Toggles one `EmployeeStationAbility` row
 * between "preferred" and "ok" only. Never touches "forbidden" or
 * "training" — the star doesn't show for those, and if it's ever tapped
 * anyway the row is returned unchanged. A missing row becomes "preferred".
 * Direct single-row read/write, unlike `updateEmployee`, which replaces the
 * whole ability list for the person.
 */
export async function toggleFavorite(
  employeeId: string,
  stationId: string,
): Promise<ToggleFavoriteResult> {
  const employee = await prisma.employee.findUnique({ where: { id: employeeId } });
  if (!employee) {
    return { ok: false, status: 404, error: "Employee not found" };
  }
  const station = await prisma.station.findUnique({ where: { id: stationId } });
  if (!station) {
    return { ok: false, status: 404, error: "Station not found" };
  }

  const existing = await prisma.employeeStationAbility.findUnique({
    where: { employeeId_stationId: { employeeId, stationId } },
  });

  if (existing && (existing.level === "forbidden" || existing.level === "training")) {
    return { ok: true, level: existing.level as AbilityLevel };
  }

  if (!existing) {
    await prisma.employeeStationAbility.create({
      data: { employeeId, stationId, level: "preferred" },
    });
    return { ok: true, level: "preferred" };
  }

  const next: AbilityLevel = existing.level === "preferred" ? "ok" : "preferred";
  await prisma.employeeStationAbility.update({
    where: { employeeId_stationId: { employeeId, stationId } },
    data: { level: next },
  });
  return { ok: true, level: next };
}
