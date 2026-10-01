import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { actor, first } from "./helpers/receipt-fixtures";
import { configValue } from "./helpers/receipt-transport";

for (const stage of ["startup", "call", "handler"]) for (const mode of ["throw", "reject"]) it(`${stage}: ${mode} from Worker.write is contained by the disposable Node process`, () => {
  const input = { config: configValue(), input: { method: "lookup_request", authenticated_actor: actor, args: { browser_command: first().request } } };
  const child = spawnSync(process.execPath, ["--import", "tsx", "tests/helpers/receipt-transport-write-child.ts", stage, mode], {
    cwd: process.cwd(), input: JSON.stringify(input), encoding: "utf8", timeout: 10000,
    env: { PATH: process.env.PATH, LANG: "en_US.UTF-8", NODE_ENV: "test" },
  });
  expect(child.error).toBeUndefined(); expect(child.signal).toBeNull();
  expect(child.status, child.stderr).toBe(0); expect(child.stderr).toBe("");
  const result = JSON.parse(child.stdout);
  expect(result).toMatchObject({ stage, mode, outcome: stage === "startup" ? "history_unavailable" : stage === "handler" ? "public_response" : "unknown", signals: ["TERM"], writes: stage === "startup" ? 1 : 2, status: { adapter_worker: "unavailable", owned_worker: 0 } });
  if (stage === "handler") expect(result.response).toMatchObject({ request_id: input.input.args.browser_command.request_id, op: input.input.args.browser_command.op, state: "unavailable", reason: "result_unconfirmed", data: null });
});
