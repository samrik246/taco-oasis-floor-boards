import { prisma } from "@/lib/db";
import { hashManagerCode } from "@/lib/managers/codes";
import { isOwnerRole } from "@/lib/managers/roles";

const LAST_OWNER = "At least one owner must stay active";
const LAST_MANAGER = "At least one manager must stay active";

export type ManagerPublic = {
  id: string;
  name: string;
  active: boolean;
  longIdle: boolean;
  role: string;
};

export type ManagerPatch = {
  code?: string;
  active?: boolean;
  role?: "owner" | "manager";
  longIdle?: boolean;
};

export type MutateResult =
  | { ok: true; status: 200; manager: ManagerPublic }
  | { ok: false; status: 404 | 409 | 422; error: string };

const publicSelect = {
  id: true,
  name: true,
  active: true,
  longIdle: true,
  role: true,
} as const;

/**
 * Demote, deactivate, or delete that would leave zero active owners returns
 * 409 and writes nothing. The last-active-manager 422 still applies when the
 * row is not an exact owner. The check and the write share one transaction.
 */
export async function updateManagerAccess(
  id: string,
  input: ManagerPatch,
): Promise<MutateResult> {
  return prisma.$transaction(async (tx) => {
    const manager = await tx.manager.findUnique({ where: { id } });
    if (!manager) {
      return { ok: false as const, status: 404 as const, error: "Manager not found" };
    }
    const nextActive = input.active ?? manager.active;
    const nextRole = input.role ?? manager.role;
    const dropsOwner =
      isOwnerRole(manager.role) &&
      manager.active &&
      !(isOwnerRole(nextRole) && nextActive);
    if (dropsOwner) {
      const owners = await tx.manager.count({
        where: { active: true, role: "owner" },
      });
      if (owners <= 1) {
        return { ok: false as const, status: 409 as const, error: LAST_OWNER };
      }
    }
    if (manager.active && input.active === false) {
      const active = await tx.manager.count({ where: { active: true } });
      if (active <= 1) {
        return { ok: false as const, status: 422 as const, error: LAST_MANAGER };
      }
    }
    const updated = await tx.manager.update({
      where: { id },
      data: {
        ...(input.code != null ? { codeHash: hashManagerCode(input.code) } : {}),
        ...(input.active != null ? { active: input.active } : {}),
        ...(input.role != null ? { role: input.role } : {}),
        ...(input.longIdle != null ? { longIdle: input.longIdle } : {}),
      },
      select: publicSelect,
    });
    return { ok: true as const, status: 200 as const, manager: updated };
  });
}

export async function deleteManagerAccess(id: string): Promise<MutateResult> {
  return prisma.$transaction(async (tx) => {
    const manager = await tx.manager.findUnique({ where: { id } });
    if (!manager) {
      return { ok: false as const, status: 404 as const, error: "Manager not found" };
    }
    if (isOwnerRole(manager.role) && manager.active) {
      const owners = await tx.manager.count({
        where: { active: true, role: "owner" },
      });
      if (owners <= 1) {
        return { ok: false as const, status: 409 as const, error: LAST_OWNER };
      }
    }
    if (manager.active) {
      const active = await tx.manager.count({ where: { active: true } });
      if (active <= 1) {
        return {
          ok: false as const,
          status: 422 as const,
          error: LAST_MANAGER,
        };
      }
    }
    await tx.manager.delete({ where: { id } });
    return {
      ok: true as const,
      status: 200 as const,
      manager: {
        id: manager.id,
        name: manager.name,
        active: false,
        longIdle: manager.longIdle,
        role: manager.role,
      },
    };
  });
}
