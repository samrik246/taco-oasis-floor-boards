/** Levels leave a response only for an exact owner. Everyone else gets no key. */
export function presentEmployee<T extends { abilities?: unknown }>(
  employee: T,
  owner: boolean,
): T | Omit<T, "abilities"> {
  if (owner) return employee;
  const { abilities: _omit, ...rest } = employee;
  return rest;
}
