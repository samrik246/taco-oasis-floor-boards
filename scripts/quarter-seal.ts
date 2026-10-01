/** Build receipt from the actual finished .next; source must be clean before sealing. */
import {execFileSync} from "node:child_process";
import {readFileSync,writeFileSync} from "node:fs";
import {createHash} from "node:crypto";
import path from "node:path";
import {artifactAppDir} from "../src/lib/quarter/artifact-root";
const app=artifactAppDir(),sha=execFileSync("git",["rev-parse","HEAD"],{cwd:app,encoding:"utf8"}).trim();
const proof=path.join(app,".next/quarter-build-receipt.json"),database=process.env.DATABASE_URL;
if(!database?.startsWith("file:/"))throw new Error("ABSOLUTE_DATABASE_REQUIRED");
writeFileSync(proof,JSON.stringify({sha,sha256:createHash("sha256").update(readFileSync(path.join(app,".next/BUILD_ID"))).digest("hex")})+"\n");
process.stdout.write(execFileSync("python3",[path.join(app,"scripts/quarter_artifacts.py"),"seal","--app",app,"--database",database.slice(5),"--build-receipt",proof],{cwd:app,encoding:"utf8"}));
