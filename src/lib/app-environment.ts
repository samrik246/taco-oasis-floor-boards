import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadEnvFile } from "node:process";

/** Standalone commands run from the app root, just like Next and launchd.
 * Resolve at runtime so a prepared, relocated client never remembers a build path.
 * Existing environment values take precedence. Never log configuration contents.
 */
export function loadAppEnvironment() {
  const root=process.cwd();
  try {
    if(JSON.parse(readFileSync(join(root,"package.json"),"utf8")).name!=="taco-oasis-floor-boards" ||
      !statSync(join(root,"prisma/schema.prisma")).isFile())throw new Error();
  } catch { throw new Error("APP_ENVIRONMENT_ROOT_REQUIRED"); }
  try { loadEnvFile(join(root,".env")); }
  catch(error) {
    if((error as NodeJS.ErrnoException).code!=="ENOENT")throw new Error("APP_ENVIRONMENT_UNREADABLE");
  }
}
