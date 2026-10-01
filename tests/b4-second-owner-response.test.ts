import { expect, it, vi } from "vitest";
vi.mock("@/lib/breaks/authority", () => ({ requireGerenteSession: vi.fn(async () => ({ ok: true, manager: { id: "owner", name: "Owner", role: "owner" } })) }));
vi.mock("@/lib/breaks/manage", () => ({
  saveManagedBreak: vi.fn(async () => ({ id: "saved-pending", replaced: false, status: "pending", covers: [] })),
  loadManagedBreak: vi.fn(async () => { throw new Error("Suggestions temporarily unavailable"); }),
  clearManagedBreak: vi.fn(), replaceAutoCover: vi.fn(),
}));
import { POST } from "@/app/api/breaks/manage/route";
it("reports a committed pending save truthfully if its suggestions read fails", async () => {
  const response = await POST(new Request("http://local/api/breaks/manage", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ board: "cocina", employeeId: "example", startAt: "2046-06-06T19:00:00.000Z", endAt: "2046-06-06T19:30:00.000Z" }) }));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ id: "saved-pending", waiting: true, covers: [] });
});
