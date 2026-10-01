import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";

it("protects application boundaries, recovers partial promotion and binds independent read-back", () => {
  const output = execFileSync("python3", ["-B", "tests/b4_release_packet_checks.py"], { encoding: "utf8", timeout: 60_000 });
  expect(output).toContain("release packet checks passed");
}, 65_000);
