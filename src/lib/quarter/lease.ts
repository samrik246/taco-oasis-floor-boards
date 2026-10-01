import { AsyncLocalStorage } from "node:async_hooks";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { artifactAppDir } from "./artifact-root";
export { artifactAppDir } from "./artifact-root";
import { prisma } from "@/lib/db";
import { assertSyntheticDatabase, syntheticDatabasePath } from "./test-boundary";
import { acquireReleaseLock, releaseReleaseLock, releaseLockPathFor } from "@/lib/release-lock";
import { QuarterRefused, type QuarterDb } from "./schema";

type Lease = { path:string; claim:string; pid:number };
const context = new AsyncLocalStorage<Lease>();
let tail:Promise<void>=Promise.resolve();
export function quarterAppDir() {
  if(process.env.FLOOR_BOARDS_TEST_ROOT){
    syntheticDatabasePath();
    return path.join(process.env.FLOOR_BOARDS_TEST_ROOT,"app");
  }
  return artifactAppDir();
}
export async function quarterLeaseAppDir(db:QuarterDb=prisma):Promise<string> {
  const dir=quarterAppDir();
  if(process.env.FLOOR_BOARDS_TEST_ROOT)await assertSyntheticDatabase(db);
  return dir;
}
export async function assertReleaseLease():Promise<Lease> {
  const lease=context.getStore();
  if (!lease || lease.pid!==process.pid) throw new QuarterRefused("RELEASE_LEASE_REQUIRED",503);
  const claims=(await readdir(lease.path)).filter(n=>/^[1-9][0-9]*\.[A-Za-z0-9]+$/.test(n));
  if (claims.length!==1 || claims[0]!==lease.claim) throw new QuarterRefused("RELEASE_LEASE_LOST",503);
  return lease;
}
/** Adopt only the actual claim acquired by this process, never an HTTP-supplied lease flag. */
export async function withClaimedReleaseLease<T>(appDir:string,run:()=>Promise<T>,db:QuarterDb=prisma):Promise<T> {
  if(appDir!==await quarterLeaseAppDir(db))throw new QuarterRefused("RELEASE_LEASE_IDENTITY_MISMATCH",503);
  const dir=releaseLockPathFor(appDir);
  const claims=(await readdir(dir)).filter(n=>n.startsWith(`${process.pid}.`));
  if(claims.length!==1)throw new QuarterRefused("RELEASE_LEASE_REQUIRED",503);
  return context.run({path:dir,claim:claims[0],pid:process.pid},async()=>{await assertReleaseLease();return run();});
}
export async function withReleaseLease<T>(run:()=>Promise<T>,db:QuarterDb=prisma):Promise<T> {
  const appDir=await quarterLeaseAppDir(db);
  if(context.getStore()){await assertReleaseLease();return run();}
  // Existing lock release is PID-based. Serialize this process's owners so releasing one cannot
  // remove a concurrent owner's claim. Cross-process exclusion remains the existing protocol.
  const previous=tail;let releaseQueue!:()=>void;
  tail=new Promise<void>(resolve=>{releaseQueue=resolve;});
  await previous;
  try {
    if(!await acquireReleaseLock(appDir,process.pid,{},10_000))throw new QuarterRefused("RELEASE_BUSY",503);
    try{return await withClaimedReleaseLease(appDir,run,db);}
    finally{await releaseReleaseLock(appDir,process.pid);}
  }finally{releaseQueue();}
}
