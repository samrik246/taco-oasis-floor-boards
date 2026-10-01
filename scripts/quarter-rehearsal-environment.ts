/** Read-only synthetic installed-layout proof. Never invokes maintenance entrypoints. */
import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { safeDatabasePath } from "./test-db-path.cjs";

async function main(){
  const [mode,expected]=process.argv.slice(2);
  if(!["shared","direct"].includes(mode)||process.env.DATABASE_URL!==undefined||process.execArgv.some(a=>a.startsWith("--env-file")))throw new Error("ENVIRONMENT_PROOF_NOT_CLEARED");
  const target=safeDatabasePath({...process.env,DATABASE_URL:`file:${expected}`});
  if(realpathSync(target)!==resolve(expected))throw new Error("ENVIRONMENT_PROOF_DATABASE_MISMATCH");
  const client=mode==="shared"?(await import("../src/lib/db")).prisma:new (await import("../src/lib/prisma-client")).PrismaClient();
  try{
    if(safeDatabasePath(process.env)!==target)throw new Error("ENVIRONMENT_PROOF_CONFIG_MISMATCH");
    const rows=await client.$queryRawUnsafe<{name:string;file:string}[]>("PRAGMA database_list");
    const opened=rows.find(r=>r.name==="main")?.file;
    if(!opened||realpathSync(opened)!==target)throw new Error("ENVIRONMENT_PROOF_OPENED_MISMATCH");
    const actual=statSync(opened),intended=statSync(target);
    if(actual.dev!==intended.dev||actual.ino!==intended.ino)throw new Error("ENVIRONMENT_PROOF_IDENTITY_MISMATCH");
    console.log(JSON.stringify({mode,parentDatabaseAbsent:true,envFileFlag:false,path:target,device:actual.dev,inode:actual.ino}));
  }finally{await client.$disconnect();}
}
main().catch(()=>{console.error("ENVIRONMENT_PROOF_FAILED");process.exitCode=1;});
