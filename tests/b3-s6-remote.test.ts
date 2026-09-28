import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("B3 S6 remote editor", () => {
  it("F6 edit-board.py remote builds ssh argv and returns the stubbed exit code", () => {
    const result = spawnSync("python3", ["tests/test_edit_board.py", "RemoteTests"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  });
});
