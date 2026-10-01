import { AsyncLocalStorage } from "node:async_hooks";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { acquireReleaseLock, releaseReleaseLock, releaseLockPathFor } from "@/lib/release-lock";
import { QuarterRefused } from "./schema";

type Lease = { path:string; claim:string; pid:number };
const context = new AsyncLocalStorage<Lease>();
let tail:Promise<void>=Promise.resolve();
export function quarterAppDir() {
  // The established test runner provides an isolated root, never the shared installation lease.
  return process.env.FLOOR_BOARDS_TEST_ROOT ? path.join(process.env.FLOOR_BOARDS_TEST_ROOT,"app") : process.cwd();
}
export async function assertReleaseLease():Promise<Lease> {
  const lease=context.getStore();
  if (!lease || lease.pid!==process.pid) throw new QuarterRefused("RELEASE_LEASE_REQUIRED",503);
  const claims=(await readdir(lease.path)).filter(n=>/^[1-9][0-9]*\.[A-Za-z0-9]+$/.test(n));
  if (claims.length!==1 || claims[0]!==lease.claim) throw new QuarterRefused("RELEASE_LEASE_LOST",503);
  return lease;
}
/** Adopt only the actual claim acquired by this process, never an HTTP-supplied lease flag. */
export async function withClaimedReleaseLease<T>(appDir:string,run:()=>Promise<T>):Promise<T> {
  const dir=releaseLockPathFor(appDir);
  const claims=(await readdir(dir)).filter(n=>n.startsWith(`${process.pid}.`));
  if(claims.length!==1)throw new QuarterRefused("RELEASE_LEASE_REQUIRED",503);
  return context.run({path:dir,claim:claims[0],pid:process.pid},async()=>{await assertReleaseLease();return run();});
}
export async function withReleaseLease<T>(run:()=>Promise<T>,appDir=quarterAppDir()):Promise<T> {
  if(context.getStore()){await assertReleaseLease();return run();}
  // Existing lock release is PID-based. Serialize this process's owners so releasing one cannot
  // remove a concurrent owner's claim. Cross-process exclusion remains the existing protocol.
  const previous=tail;let releaseQueue!:()=>void;
  tail=new Promise<void>(resolve=>{releaseQueue=resolve;});
  await previous;
  try {
    if(!await acquireReleaseLock(appDir,process.pid,{},10_000))throw new QuarterRefused("RELEASE_BUSY",503);
    try{return await withClaimedReleaseLease(appDir,run);}
    finally{await releaseReleaseLock(appDir,process.pid);}
  }finally{releaseQueue();}
}
