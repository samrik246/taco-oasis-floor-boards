/** Display classification only. Import routing and BREAK authority stay unchanged. */
export function isAuxiliaryPosition(position: string): boolean {
  const name = position.trim().replace(/\s+/g, " ").toLowerCase();
  if (name.includes("catering")) return false;
  if (["caja - gm", "caja - up manager", "gm", "up manager"].includes(name)) return true;
  return !name.includes("caja") && !name.includes("cocina");
}

export function isMainBoardPosition(position: string): boolean {
  return !position.toLowerCase().includes("catering") && !isAuxiliaryPosition(position);
}
