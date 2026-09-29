import { appendFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";

/**
 * Fake Epson TM-m30II-H on 127.0.0.1 for the Imprimir e2e. Each received
 * ticket is appended to tickets.jsonl (hex) so the spec can count them.
 */
const MODEL_QUERY = Buffer.from([0x1d, 0x49, 0x43]);
const DLE_EOT = Buffer.from([0x10, 0x04]);
const INIT = Buffer.from([0x1b, 0x40]);
const CUT = Buffer.from([0x1d, 0x56, 0x42, 0x00]);
const READY: Record<number, number> = { 1: 0x16, 2: 0x12, 3: 0x12, 4: 0x12 };

export default async function globalSetup() {
  const root = process.env.T4G_PRINT_E2E_ROOT!;
  const log = join(root, "tickets.jsonl");
  writeFileSync(log, "");
  const server = net.createServer((sock) => {
    sock.on("error", () => undefined);
    let buf = Buffer.alloc(0);
    let ticket: Buffer | null = null;
    sock.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length) {
        if (ticket) {
          const joined = Buffer.concat([ticket, buf]);
          const cut = joined.indexOf(CUT);
          const end = cut === -1 ? buf.length : cut + CUT.length - ticket.length;
          ticket = Buffer.concat([ticket, buf.subarray(0, end)]);
          buf = buf.subarray(end);
          if (cut !== -1) {
            appendFileSync(log, JSON.stringify({ hex: ticket.toString("hex") }) + "\n");
            ticket = null;
          }
          continue;
        }
        if (buf.subarray(0, 3).equals(MODEL_QUERY)) {
          buf = buf.subarray(3);
          sock.write(Buffer.from("_TM-m30II-H\0", "latin1"));
        } else if (buf.subarray(0, 2).equals(DLE_EOT)) {
          if (buf.length < 3) break;
          const n = buf[2];
          buf = buf.subarray(3);
          sock.write(Buffer.from([READY[n]]));
        } else if (buf.subarray(0, 2).equals(INIT)) {
          ticket = Buffer.alloc(0);
        } else {
          sock.destroy();
          return;
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  writeFileSync(
    join(root, "three_part.json"),
    JSON.stringify({
      three_part: {
        printers: { fake: { host: "127.0.0.1", port, model: "TM-m30II-H" } },
        stations: { CALIENTE: "fake", FRIO: "fake", EQUIPO: "fake", GERENTE: "fake" },
        timeout_seconds: 3,
        ledger_path: join(root, "t4g.sqlite"),
      },
    }),
  );
  return async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
}
