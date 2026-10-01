import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";

/** Contract R2 §8.2. Never select credentials, email, or unspecified columns. */
import registry from "./preservation-columns.json";
export const PRESERVATION_COLUMNS:Readonly<Record<string,readonly string[]>> = registry;
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
    const encoded=rows.map(row=>columns.map(c=>[row[c+":type"],row[c+":value"]])).sort((a,b)=>Buffer.compare(Buffer.from(JSON.stringify(a)),Buffer.from(JSON.stringify(b))));
    tables[table]={rows:rows.length,sha256:hash(encoded)};
  }
  const schema=await schemaFingerprint(db);
  const foreignKeys=await db.$queryRawUnsafe<{foreign_keys:bigint}[]>("PRAGMA foreign_keys");
  const violations=await db.$queryRawUnsafe<unknown[]>("PRAGMA foreign_key_check");
  return {version:1,tables,schemaSha256:schema,foreignKeys:Number(foreignKeys[0].foreign_keys),foreignKeyViolations:violations.length};
}

/** Full definition fingerprint, never row contents from undeclared/credential tables. */
export async function schemaFingerprint(db:Prisma.TransactionClient):Promise<string> {
  const rows=await db.$queryRawUnsafe<{type:string;name:string;tbl_name:string;sql:string|null}[]>("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name");
  return hash(rows.map(r=>[r.type,r.name,r.tbl_name,r.sql]));
}
