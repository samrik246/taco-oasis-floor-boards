import { join } from "node:path";
import { loadEnvFile } from "node:process";
import { artifactAppDir } from "./quarter/artifact-root";

/** Resolve from the loaded source/server module, independently of launch cwd.
 * A prepared, relocated client must never remember a build path or load another app's settings.
 * Existing environment values take precedence. Never log configuration contents.
 */
export function loadAppEnvironment() {
  let root:string;
  try { root=artifactAppDir(); }
  catch { throw new Error("APP_ENVIRONMENT_ROOT_REQUIRED"); }
  try { loadEnvFile(join(root,".env")); }
  catch(error) {
    if((error as NodeJS.ErrnoException).code!=="ENOENT")throw new Error("APP_ENVIRONMENT_UNREADABLE");
  }
}
