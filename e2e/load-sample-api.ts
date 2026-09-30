import { expect, type Page } from "@playwright/test";

/** The sample button is gone. Tests load the fixture through the API. */
export async function ensureSampleLoaded(page: Page, day = "2026-09-20"): Promise<boolean> {
  const login = await page.request.post("/api/managers", { data: { code: "8642" } });
  expect(login.ok()).toBeTruthy();
  const { sessionToken } = (await login.json()) as { sessionToken: string };
  const headers = { "x-manager-session": sessionToken };
  const days = (await (await page.request.get("/api/days", { headers })).json()) as { dates: string[] };
  if (days.dates.includes(day)) return false;
  const sample = await page.request.get("/api/sample", { headers });
  expect(sample.ok()).toBeTruthy();
  await page.reload();
  return true;
}
