/** Shared manager-note DTO (safe for client imports). */

export type ManagerNoteDto = {
  id: string;
  board: "caja" | "cocina";
  date: string;
  body: string;
  author: string;
  createdAt: string;
  updatedAt: string;
  /** America/Chicago wall-clock label for display */
  chicagoTimestamp: string;
};
