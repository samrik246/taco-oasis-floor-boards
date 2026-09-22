/** Safe to import from client components: the manager token is supplied at runtime. */
export function managerAuthHeaders(
  token?: string | null,
): Record<string, string> {
  return token ? { "x-manager-session": token } : {};
}
