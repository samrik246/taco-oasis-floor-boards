import { it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

it("the dry-run cannot turn either an omission or intentional erasure into a live repair", () => {
  const root = fs.mkdtempSync(path.join(process.env.FLOOR_BOARDS_TEST_ROOT!, "nieves-delta-"));
  const input = path.join(root, "receipt.json"), out = path.join(root, "delta.json");
  const bytes = JSON.stringify({ query_only: 1, observedAt: "2042-10-12T15:00:00Z", database: "synthetic-unopened.db",
    shifts: ["import-omission", "intentional-erasure"].map(id => ({ id, date: "2042-10-12", sourcePosition: "Caja - Nieves", boardRemoved: 0,
      startAt: Date.parse("2042-10-12T16:00:00Z"), endAt: Date.parse("2042-10-12T17:00:00Z"), firstName: id, lastName: "Synthetic", assignedHours: 0, assignedStations: null })) });
  fs.writeFileSync(input, bytes); const hash = createHash("sha256").update(bytes).digest("hex");
  const command = ["scripts/nieves-gap-dry-run.py", "--receipt", input, "--expected-sha256", hash, "--out", out];
  execFileSync("python3", command);
  const report = JSON.parse(fs.readFileSync(out, "utf8"));
  expect(report).toMatchObject({ databaseWrites: 0, executableRepair: false, proposedDelta: [], inputReceiptSha256: hash });
  expect(report.excluded.map((r: { reason: string }) => r.reason)).toEqual(["AMBIGUOUS_BLANK_INTENT", "AMBIGUOUS_BLANK_INTENT"]);
  expect(fs.readFileSync(input, "utf8")).toBe(bytes); expect(fs.existsSync("synthetic-unopened.db")).toBe(false);
  expect(() => execFileSync("python3", command, { stdio: "pipe" })).toThrow();
  expect(() => execFileSync("python3", ["scripts/nieves-gap-dry-run.py", "--receipt", input, "--expected-sha256", "0".repeat(64), "--out", path.join(root, "bad.json")], { stdio: "pipe" })).toThrow();
  expect(fs.existsSync(path.join(root, "bad.json"))).toBe(false);
  fs.rmSync(root, { recursive: true, force: true });
});
