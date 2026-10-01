import type { Prisma, PrismaClient } from "@prisma/client";

/** The first statement of every board-decision write transaction. */
export async function acquireBoardWrite(tx: Prisma.TransactionClient): Promise<void> {
  await tx.staffBreakLock.upsert({where:{id:1},create:{id:1},update:{updatedAt:new Date()}});
}
export function boardWrite<T>(client: PrismaClient, write:(tx:Prisma.TransactionClient)=>Promise<T>):Promise<T> {
  return client.$transaction(async tx=>{await acquireBoardWrite(tx);return write(tx);}, {maxWait:10_000,timeout:30_000});
}
