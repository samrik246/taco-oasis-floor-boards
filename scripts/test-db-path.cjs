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
  if (db === INSTALLED_DB) throw new Error("TEST_DB_INSTALLED_OR_SYMLINK");
  const parentReal = fs.realpathSync(path.dirname(db));
  const dbReal = path.join(parentReal, path.basename(db));
  if (rootReal !== root || dbReal !== db || !dbReal.startsWith(rootReal + path.sep)) {
    throw new Error("TEST_DB_OUTSIDE_DISPOSABLE_ROOT");
  }
  if (dbReal === INSTALLED_DB || fs.lstatSync(dbReal, { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw new Error("TEST_DB_INSTALLED_OR_SYMLINK");
  }
  return dbReal;
}

/** The actual connection must be the configured disposable file, not another DB under its root. */
function safeOpenedDatabasePath(file, env = process.env) {
  const configured = safeDatabasePath(env);
  if (!file || file !== configured || fs.realpathSync(file) !== configured) {
    throw new Error("TEST_DB_CONNECTION_MISMATCH");
  }
  return configured;
}

module.exports = { safeDatabasePath, safeOpenedDatabasePath };
