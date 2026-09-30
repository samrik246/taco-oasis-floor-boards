#!/usr/bin/env python3
"""Synthetic old/new/old/new boots on one SQLite file. Source archives only; no database copies.
Run from the B4 worktree. Needs offline pnpm packages and a local Node runtime.
"""
import hashlib
from http.client import HTTPConnection, HTTPException
import json
import os
from pathlib import Path
import signal
import socket
import sqlite3
import subprocess
import tarfile
import time
import uuid

BASE = "bdf8646e514cc76845653f40798a7061dccc9349"
repo = Path(__file__).resolve().parent.parent
root = Path("/tmp").resolve() / ("color-boards-test-" + uuid.uuid4().hex)
root.mkdir()
old = root / "old-source"
old.mkdir()
database = root / "rehearsal.db"
database.touch()
env = {k: os.environ[k] for k in ("PATH", "HOME", "LANG") if k in os.environ}
env.update(DATABASE_URL="file:" + str(database), FLOOR_BOARDS_TEST_ROOT=str(root),
           MANAGER_SESSION_SECRET="b4-rehearsal-synthetic-session-secret-0000",
           STAFF_PASSCODE_PEPPER="b4-rehearsal-synthetic-pepper-0000000",
           FLOOR_BOARDS_E2E_NOW="2040-06-06T13:00:00.000Z", NEXT_TELEMETRY_DISABLED="1")
log = open(root / "commands.log", "w")


def run(args, cwd=repo, input=None):
    log.write("RUN " + json.dumps(args) + " CWD " + str(cwd) + "\n")
    log.flush()
    subprocess.run(args, cwd=cwd, env=env, input=input, text=True, stdout=log, stderr=log, check=True)


def http(port, method, path, body=None, token=None):
    conn = HTTPConnection("127.0.0.1", port, timeout=20)
    headers = {"content-type": "application/json"}
    if token:
        headers["x-manager-session"] = token
    conn.request(method, path, body=json.dumps(body) if body is not None else None, headers=headers)
    response = conn.getresponse()
    content = json.loads(response.read())
    status = response.status
    conn.close()
    assert status < 400, (method, path, status)
    return content


def boot(cwd, phase, probe):
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    output = open(root / (phase + ".log"), "w")
    proc = subprocess.Popen(["pnpm", "exec", "next", "start", "-H", "127.0.0.1", "-p", str(port)], cwd=cwd, env=env, stdout=output, stderr=output, start_new_session=True)
    try:
        for _ in range(150):
            if proc.poll() is not None:
                raise RuntimeError(phase + " exited before ready")
            try:
                http(port, "GET", "/api/managers")
                break
            except (OSError, HTTPException):
                time.sleep(.2)
        else:
            raise RuntimeError(phase + " did not become ready")
        auth = http(port, "POST", "/api/managers", {"code": "rehearsal-owner-code"})
        probe(port, auth["sessionToken"])
        print(phase + " boot/read/write passed", flush=True)
    finally:
        os.killpg(proc.pid, signal.SIGTERM)
        proc.wait(timeout=20)
        output.close()


def structural():
    with sqlite3.connect(database) as db:
        return {
            "schema": db.execute("SELECT sql FROM sqlite_master WHERE name='Manager'").fetchone()[0],
            "rows": db.execute('SELECT rowid,id FROM "Manager" ORDER BY rowid').fetchall(),
            "breaks": db.execute('SELECT id,status,coverEmployeeId,coverShiftId,auto FROM "StaffBreak" ORDER BY id').fetchall(),
        }


try:
    archive = root / "old-source.tar"
    with open(archive, "wb") as out:
        subprocess.run(["git", "archive", BASE], cwd=repo, stdout=out, check=True)
    with tarfile.open(archive) as tar:
        for member in tar.getmembers():
            target = (old / member.name).resolve()
            if not (member.isfile() or member.isdir()) or old not in target.parents:
                raise ValueError("Unexpected source archive member")
        tar.extractall(old)
    run(["pnpm", "install", "--offline", "--frozen-lockfile", "--ignore-scripts"], old)
    run(["pnpm", "exec", "prisma", "generate"], old)
    # Fresh synthetic schema creation only, before any migration. Never used on rollback.
    run(["pnpm", "exec", "prisma", "db", "push", "--skip-generate"], old)
    run(["node", "-"], old, r'''
const { PrismaClient } = require('@prisma/client');
const { createHash } = require('node:crypto');
const db = new PrismaClient();
(async () => {
 const codeHash = createHash('sha256').update('taco-oasis-manager-v1:rehearsal-owner-code').digest('hex');
 await db.manager.create({data:{id:'proof-owner',name:'Synthetic Owner',codeHash,role:'owner'}});
 await db.manager.create({data:{id:'proof-manager',name:'Synthetic Gerente',codeHash:'synthetic-unused',role:'manager'}});
 for (const id of ['one','two','pending','old-writer']) {
  await db.employee.create({data:{id,externalId:'proof-'+id,firstName:id,lastName:'Synthetic'}});
  await db.shift.create({data:{id:'shift-'+id,employeeId:id,date:'2040-06-06',board:'cocina',sourcePosition:id==='two'?'Cocina Guia Abrir':'Cocina',startAt:new Date('2040-06-06T12:00:00Z'),endAt:new Date('2040-06-07T01:00:00Z')}});
 }
 await db.staffBreak.create({data:{id:'proof-booked',employeeId:'one',shiftId:'shift-one',board:'cocina',date:'2040-06-06',startAt:new Date('2040-06-06T19:00:00Z'),endAt:new Date('2040-06-06T19:15:00Z'),actor:'one',status:'booked',coverEmployeeId:'two',coverShiftId:'shift-two',auto:false}});
 await db.staffBreak.create({data:{id:'proof-pending',employeeId:'pending',shiftId:'shift-pending',board:'cocina',date:'2040-06-06',startAt:new Date('2040-06-06T19:30:00Z'),endAt:new Date('2040-06-06T19:45:00Z'),actor:'pending',status:'pending'}});
 await db.$disconnect();
})().catch(e=>{console.error(e);process.exitCode=1});
''')
    run(["pnpm", "build"], old)
    def old_probe(port, token):
        http(port, "GET", "/api/breaks/manage?board=cocina&employeeId=pending", token=token)
        http(port, "POST", "/api/breaks/manage", {"board": "cocina", "employeeId": "old-writer", "startAt": "2040-06-06T14:00:00.000Z", "endAt": "2040-06-06T14:15:00.000Z"}, token)
        http(port, "POST", "/api/notes", {"board": "cocina", "date": "2040-06-06", "body": "Synthetic rollback write"}, token)
    boot(old, "old-before", old_probe)
    before = structural()
    run(["python3", "scripts/migrate-manager-linkage.py", str(database)])
    after = structural()
    assert before["rows"] == after["rows"] and before["breaks"] == after["breaks"]
    assert '"employeeId" TEXT' in after["schema"]
    run(["python3", "scripts/migrate-manager-linkage.py", str(database)])
    run(["pnpm", "build"])
    def new_probe(port, token):
        http(port, "PUT", "/api/admin/manager-pairings", {"managerId": "proof-manager", "employeeId": "two", "confirm": True}, token)
        pairs = http(port, "GET", "/api/admin/manager-pairings", token=token)
        assert next(m for m in pairs["managers"] if m["id"] == "proof-manager")["employeeId"] == "two"
        timeline = http(port, "GET", "/api/breaks/timeline?date=2040-06-06", token=token)
        assert any(b["id"] == "proof-pending" and b["status"] == "pending" for b in timeline["breaks"])
    boot(repo, "new-before-rollback", new_probe)
    boot(old, "old-after-migration", old_probe)
    # An old client creates a manager after migration, omitting the unknown nullable column.
    run(["node", "-"], old, "const {PrismaClient}=require('@prisma/client');const db=new PrismaClient();db.manager.create({data:{id:'old-created',name:'Synthetic Old Writer',codeHash:'synthetic-unused'}}).finally(()=>db.$disconnect());")
    with sqlite3.connect(database) as db:
        assert db.execute('SELECT employeeId FROM Manager WHERE id="old-created"').fetchone() == (None,)
        assert db.execute('SELECT employeeId FROM Manager WHERE id="proof-manager"').fetchone() == ("two",)
    boot(repo, "new-after-rollback", new_probe)
    final = structural()
    assert final["breaks"] == before["breaks"]
    assert final["rows"][:len(before["rows"])] == before["rows"]
    result = {"base": BASE, "newHead": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip(),
              "database": str(database), "managerSchemaBefore": before["schema"], "managerSchemaAfter": after["schema"],
              "rowidsPreserved": True, "pendingAndBookedPreserved": True, "oldCreatedNullLinkage": True,
              "migrationSha256": hashlib.sha256((repo / "scripts/migrate-manager-linkage.py").read_bytes()).hexdigest()}
    (root / "result.json").write_text(json.dumps(result, indent=2) + "\n")
    print("RESULT " + str(root / "result.json"), flush=True)
finally:
    log.close()
    print("EVIDENCE " + str(root), flush=True)
