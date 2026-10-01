import path from "node:path";
import {existsSync,readFileSync,realpathSync} from "node:fs";
/** Loaded source/server module identity, independent of the launch directory. */
export function artifactAppDir():string {
  let dir=realpathSync(__dirname);
  for(;;){
    const pkg=path.join(dir,"package.json");
    if(existsSync(pkg)&&JSON.parse(readFileSync(pkg,"utf8")).name==="taco-oasis-floor-boards"&&existsSync(path.join(dir,"prisma/schema.prisma")))return dir;
    const parent=path.dirname(dir);if(parent===dir)throw new Error("ARTIFACT_ROOT_NOT_FOUND");dir=parent;
  }
}
