import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";

/** Contract R2 §8.2. Never select credentials, email, or unspecified columns. */
export const PRESERVATION_COLUMNS = {
  "Manager": [
    "rowid",
    "id",
    "employeeId",
    "name",
    "active",
    "longIdle",
    "role",
    "createdAt",
    "updatedAt"
  ],
  "Employee": [
    "id",
    "externalId",
    "firstName",
    "lastName",
    "createdAt",
    "updatedAt"
  ],
  "Station": [
    "id",
    "board",
    "label",
    "color",
    "maxConcurrent",
    "sortOrder",
    "priority",
    "shortCode"
  ],
  "PositionStationMap": [
    "position",
    "stationId",
    "updatedAt"
  ],
  "EmployeeStationAbility": [
    "employeeId",
    "stationId",
    "level"
  ],
  "AbilityColumnSetting": [
    "key",
    "hidden",
    "defaultLevel",
    "updatedAt"
  ],
  "MandatoryMark": [
    "id",
    "board",
    "date",
    "stationId",
    "createdAt",
    "managerId"
  ],
  "Shift": [
    "rowid",
    "id",
    "employeeId",
    "date",
    "startAt",
    "endAt",
    "sourcePosition",
    "board",
    "importBatchId",
    "supersededAt",
    "supersededByBatchId",
    "boardRemoved"
  ],
  "Assignment": [
    "rowid",
    "id",
    "employeeId",
    "shiftId",
    "stationId",
    "hourStart",
    "hourEnd",
    "seatNumber"
  ],
  "StaffBreak": [
    "rowid",
    "id",
    "employeeId",
    "shiftId",
    "board",
    "date",
    "startAt",
    "endAt",
    "createdAt",
    "updatedAt",
    "actor",
    "status",
    "coverEmployeeId",
    "coverShiftId",
    "shuffleEmployeeId",
    "shuffleShiftId",
    "auto"
  ],
  "StaffBreakLock": [
    "id",
    "updatedAt"
  ],
  "BoardOverlay": [
    "id",
    "date",
    "board",
    "kind",
    "employeeId",
    "partnerEmployeeId",
    "stationId",
    "fromStationId",
    "startAt",
    "endAt",
    "managerId",
    "managerName",
    "cancelledAt",
    "endReason",
    "createdAt"
  ],
  "ShiftRemoval": [
    "id",
    "shiftId",
    "externalId",
    "date",
    "board",
    "sourcePosition",
    "startAt",
    "endAt",
    "state",
    "revision",
    "cellsJson",
    "createdAt",
    "updatedAt"
  ],
  "ShiftRemovalEvent": [
    "id",
    "overrideId",
    "action",
    "revision",
    "managerId",
    "managerName",
    "reason",
    "sourceJson",
    "cellsJson",
    "createdAt"
  ],
  "ImportBatch": [
    "id",
    "filename",
    "fingerprint",
    "importedAt",
    "rowCount"
  ],
  "PositionMoveLog": [
    "id",
    "date",
    "hour",
    "employeeId",
    "fromStationId",
    "toStationId",
    "assignmentId",
    "reason",
    "note",
    "createdAt"
  ],
  "BoardChangeLog": [
    "id",
    "createdAt",
    "managerId",
    "managerName",
    "route",
    "date",
    "summary"
  ],
  "LoadStationMeter": [
    "loadStationId",
    "level",
    "orderCount",
    "updatedAt"
  ],
  "TareaAssignment": [
    "id",
    "date",
    "employeeId",
    "templateId",
    "status",
    "forceLemon",
    "assignedAt",
    "completedAt",
    "unassignedAt"
  ],
  "ReturnPrompt": [
    "id",
    "date",
    "employeeId",
    "loadStationId",
    "seatId",
    "message",
    "createdAt",
    "acknowledgedAt"
  ],
  "QuarterSchema": [
    "id",
    "schemaVersion",
    "phase",
    "databaseEpoch",
    "minReader",
    "minWriter",
    "migrationSha256",
    "activatedAtMs"
  ],
  "QuarterWorldRevision": [
    "id",
    "revision"
  ],
  "PaintHour": [
    "id",
    "shiftId",
    "employeeId",
    "date",
    "board",
    "hourStartMs",
    "revision",
    "sourceJson",
    "sourceSha256",
    "legacyJson",
    "legacySha256",
    "adoptedAtMs",
    "updatedAtMs"
  ],
  "PaintSegment": [
    "id",
    "paintHourId",
    "quarterStartMs",
    "startMs",
    "endMs",
    "state",
    "stationId",
    "seatNumber"
  ],
  "PaintCommandReceipt": [
    "actorId",
    "requestId",
    "requestSha256",
    "databaseEpoch",
    "revisionBefore",
    "revisionAfter",
    "responseJson",
    "committedAtMs"
  ],
  "PaintMutation": [
    "id",
    "actorId",
    "requestId",
    "date",
    "board",
    "shiftId",
    "startMs",
    "endMs",
    "operation",
    "reason",
    "moveNote",
    "beforeJson",
    "afterJson",
    "createdAtMs"
  ]
} as const;
export const QUARTER_TABLES = new Set(["QuarterSchema","QuarterWorldRevision","PaintHour","PaintSegment","PaintCommandReceipt","PaintMutation"]);
const hash=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
const quote=(name:string)=>`"${name.replaceAll('"','""')}"`;
export async function assertPreservationColumns(db:Prisma.TransactionClient, includeQuarter:boolean):Promise<void> {
  for(const [table,columns] of Object.entries(PRESERVATION_COLUMNS)) {
    if(!includeQuarter && QUARTER_TABLES.has(table))continue;
    const info=await db.$queryRawUnsafe<{name:string}[]>(`PRAGMA table_info(${quote(table)})`);
    const names=new Set(info.map(c=>c.name));
    if(!info.length||columns.some(c=>c!=="rowid"&&!names.has(c)))throw new Error(`QUARTER_PRESERVATION_SCHEMA_MISMATCH:${table}`);
  }
}
/** Hash typed values in one caller snapshot; return only counts and digests. */
export async function captureQuarterPreservation(db:Prisma.TransactionClient, includeQuarter=true) {
  await assertPreservationColumns(db,includeQuarter);
  const tables:Record<string,{rows:number;sha256:string}>={};
  for(const [table,columns] of Object.entries(PRESERVATION_COLUMNS)) {
    if(!includeQuarter && QUARTER_TABLES.has(table))continue;
    // Prisma 5.22 raw INTEGER decoding cannot carry epoch milliseconds. Preserve SQL types
    // explicitly and read their decimal/text representation without narrowing to int32.
    const fields=columns.flatMap(c=>[`typeof(${quote(c)}) AS ${quote(c+":type")}`,`CAST(${quote(c)} AS TEXT) AS ${quote(c+":value")}`]);
    const rows=await db.$queryRawUnsafe<Record<string,string|null>[]>(`SELECT ${fields.join(",")} FROM ${quote(table)}`);
    const encoded=rows.map(row=>columns.map(c=>[row[c+":type"],row[c+":value"]])).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
    tables[table]={rows:rows.length,sha256:hash(encoded)};
  }
  const names=Object.keys(tables), placeholders=names.map(()=>"?").join(",");
  const schema=await db.$queryRawUnsafe<{type:string;name:string;tbl_name:string;sql:string|null}[]>(`SELECT type,name,tbl_name,sql FROM sqlite_master WHERE tbl_name IN (${placeholders}) ORDER BY type,name`,...names);
  const foreignKeys=await db.$queryRawUnsafe<{foreign_keys:bigint}[]>("PRAGMA foreign_keys");
  const violations=await db.$queryRawUnsafe<unknown[]>("PRAGMA foreign_key_check");
  return {version:1,tables,schemaSha256:hash(schema),foreignKeys:Number(foreignKeys[0].foreign_keys),foreignKeyViolations:violations.length};
}
