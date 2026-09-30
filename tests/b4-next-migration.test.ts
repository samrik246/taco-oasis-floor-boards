import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

it("adds only a nullable link, preserves rowids/state, reruns, and fails before an incompatible mutation", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "b4-linkage-"));
  const result = execFileSync("python3", ["-", path.join(process.cwd(), "scripts/migrate-manager-linkage.py"), root], { encoding: "utf8", input: `
import importlib.util, pathlib, sqlite3, sys
spec=importlib.util.spec_from_file_location('migration',sys.argv[1]); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
root=pathlib.Path(sys.argv[2])
for bad in (False,True):
 p=root/('bad.db' if bad else 'good.db')
 with sqlite3.connect(p) as db:
  db.execute('CREATE TABLE Manager(id TEXT PRIMARY KEY,name TEXT,codeHash TEXT,active BOOLEAN,role TEXT'+(', employeeId INTEGER NOT NULL DEFAULT 0' if bad else '')+')')
  db.execute("INSERT INTO Manager(rowid,id,name,codeHash,active,role) VALUES(41,'synthetic','Example','not-a-real-credential',1,'manager')")
  db.execute('CREATE TABLE StaffBreak(id TEXT,status TEXT)')
  db.executemany('INSERT INTO StaffBreak VALUES(?,?)',[('one','pending'),('two','booked')])
  before=db.execute('SELECT sql FROM sqlite_master ORDER BY name').fetchall()
 if bad:
  try: m.migrate(p)
  except ValueError: pass
  else: raise AssertionError('incompatible column accepted')
  with sqlite3.connect(p) as db: assert before==db.execute('SELECT sql FROM sqlite_master ORDER BY name').fetchall()
 else:
  assert m.migrate(p)['changed'] is True
  assert m.migrate(p)['changed'] is False
  with sqlite3.connect(p) as db:
   assert db.execute('SELECT rowid,employeeId FROM Manager').fetchall()==[(41,None)]
   assert db.execute('SELECT status FROM StaffBreak ORDER BY id').fetchall()==[('pending',),('booked',)]
   assert len(db.execute('PRAGMA table_info(Manager)').fetchall())==6
   db.execute("INSERT INTO Manager(id,name,codeHash,active,role) VALUES('old-created','Old Writer','synthetic',1,'manager')")
   assert db.execute("SELECT employeeId FROM Manager WHERE id='old-created'").fetchone()==(None,)
print('migration invariants passed')
` });
  expect(result).toContain("migration invariants passed");
});
