import net from "node:net";

/**
 * Loopback stand-in for the Epson TM-m30II-H on :9100. Tests only.
 * Answers GS I C with the model id and DLE EOT n with an all-clear status;
 * everything from ESC @ through the partial cut is one received ticket.
 */
const MODEL_QUERY = Buffer.from([0x1d, 0x49, 0x43]);
const DLE_EOT = Buffer.from([0x10, 0x04]);
const INIT = Buffer.from([0x1b, 0x40]);
const CUT = Buffer.from([0x1d, 0x56, 0x42, 0x00]);
const READY: Record<number, number> = { 1: 0x16, 2: 0x12, 3: 0x12, 4: 0x12 };

export type FakeEpson = {
  port: number;
  tickets: Buffer[];
  connections: number;
  close: () => Promise<void>;
};

export async function startFakeEpson(opts: { status?: Record<number, number>; silentAfterTickets?: number } = {}): Promise<FakeEpson> {
  const status = { ...READY, ...(opts.status ?? {}) };
  const state = { tickets: [] as Buffer[], connections: 0 };
  const sockets = new Set<net.Socket>();
  const server = net.createServer((sock) => {
    state.connections += 1;
    sockets.add(sock);
    sock.on("close", () => sockets.delete(sock));
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
            state.tickets.push(ticket);
            ticket = null;
          }
          continue;
        }
        if (buf.subarray(0, 3).equals(MODEL_QUERY)) {
          buf = buf.subarray(3);
          if (opts.silentAfterTickets != null && state.tickets.length >= opts.silentAfterTickets) continue;
          sock.write(Buffer.from("_TM-m30II-H\0", "latin1"));
        } else if (buf.subarray(0, 2).equals(DLE_EOT)) {
          if (buf.length < 3) break;
          const n = buf[2];
          buf = buf.subarray(3);
          sock.write(Buffer.from([status[n]]));
        } else if (buf.subarray(0, 2).equals(INIT)) {
          ticket = Buffer.alloc(0);
        } else {
          if (buf.length < 3) break;
          throw new Error(`fake printer got stray bytes ${buf.subarray(0, 8).toString("hex")}`);
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  return {
    port,
    get tickets() {
      return state.tickets;
    },
    get connections() {
      return state.connections;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
