import { describe, expect, it } from "vitest";
import { PUT as assignHour } from "@/app/api/assignments/route";
import { PUT as assignShift } from "@/app/api/assignments/shift/route";
import { POST as swap } from "@/app/api/assignments/swap/route";
import { PUT as paint } from "@/app/api/assignments/paint/route";

describe("assignment manager boundary", () => {
  const cases = [
    { name: "one hour", method: "PUT", path: "/api/assignments", handler: assignHour },
    { name: "whole shift", method: "PUT", path: "/api/assignments/shift", handler: assignShift },
    { name: "swap", method: "POST", path: "/api/assignments/swap", handler: swap },
    { name: "paint", method: "PUT", path: "/api/assignments/paint", handler: paint },
  ] as const;

  for (const { name, method, path, handler } of cases) {
    it(`refuses ${name} before reading an unauthenticated write`, async () => {
      const request = new Request(`http://local${path}`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: "this body is deliberately not JSON",
      });
      const response = await handler(request);
      expect(response.status).toBe(401);
    });

    it(`refuses ${name} with an invalid manager token`, async () => {
      const request = new Request(`http://local${path}`, {
        method,
        headers: { "x-manager-session": "invalid" },
      });
      const response = await handler(request);
      expect(response.status).toBe(401);
    });
  }
});
