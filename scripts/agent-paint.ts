import { quarterAppDir } from "../src/lib/quarter/lease";
/**
 * Host colour-edit command. Reads one JSON packet on stdin.
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/agent-paint.ts --preflight
 *   node node_modules/tsx/dist/cli.mjs scripts/agent-paint.ts --apply <sha256>
 *
 * Run from the installed release. --apply holds the shared release lock,
 * re-reads RELEASE_SHA, then saves. Exit 0 saved or preflight finished,
 * 2 rule refusal, 3 bad packet or SHA, 4 wrong release, 1 other.
 */
import { prisma } from "../src/lib/db";
import { AgentPaintExit, parseAgentPaintArgs, runAgentPaint } from "../src/lib/agent-paint";

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk: Buffer | string) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

async function main(): Promise<void> {
  const args = parseAgentPaintArgs(process.argv.slice(2));
  const raw = await readStdin();
  const result = await runAgentPaint({
    raw,
    mode: args.mode,
    applySha: args.applySha,
    appDir: quarterAppDir(),
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.code;
}

main()
  .catch((error: unknown) => {
    const exitCode = error instanceof AgentPaintExit ? error.exitCode : 1;
    const detail = error instanceof AgentPaintExit ? error.message : "The command failed.";
    const kind = exitCode === 3 ? "packet" : "command";
    process.stderr.write(`${JSON.stringify({ error: kind, detail })}\n`);
    process.exitCode = exitCode;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
