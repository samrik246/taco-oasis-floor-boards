const fs = require("node:fs");
const path = require("node:path");

const INSTALLED_DB = "/Users/dan/.buzz/COLOR_BOARDS_APP/var/data/floor-boards.db";

function safeDatabasePath(env = process.env) {
  const root = env.FLOOR_BOARDS_TEST_ROOT;
  const url = env.DATABASE_URL;
  const tempDir = fs.realpathSync("/tmp");
  if (!root || !path.isAbsolute(root) || path.dirname(root) !== tempDir ||
      !/^color-boards-test-[A-Za-z0-9]+$/.test(path.basename(root))) {
    throw new Error("TEST_DB_ROOT_NOT_DISPOSABLE");
  }
  if (!url || !url.startsWith("file:/") || /[?#]/.test(url)) {
    throw new Error("TEST_DB_URL_NOT_ABSOLUTE_SQLITE");
  }
  const rootReal = fs.realpathSync(root);
  const db = url.slice("file:".length);
  const parentReal = fs.realpathSync(path.dirname(db));
  const dbReal = path.join(parentReal, path.basename(db));
  if (rootReal !== root || dbReal !== db || !dbReal.startsWith(rootReal + path.sep)) {
    throw new Error("TEST_DB_OUTSIDE_DISPOSABLE_ROOT");
  }
  if (dbReal === INSTALLED_DB || (fs.existsSync(dbReal) && fs.lstatSync(dbReal).isSymbolicLink())) {
    throw new Error("TEST_DB_INSTALLED_OR_SYMLINK");
  }
  return dbReal;
}

module.exports = { safeDatabasePath };
