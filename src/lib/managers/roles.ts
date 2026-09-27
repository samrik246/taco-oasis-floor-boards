/** Exact stored role that may open owner routes. Anything else fails closed. */
export const OWNER_ROLE = "owner";

export const MANAGER_ROLE = "manager";

export function isOwnerRole(role: string | null | undefined): boolean {
  return role === OWNER_ROLE;
}
