import type { Page } from "@playwright/test";

/** Keep paint idle regressions fast when their historical fixture now needs owner access. */
export async function ownerShortIdle(page: Page) {
  await page.route("**/api/managers", async route => {
    const response = await route.fetch();
    const body = await response.json();
    if (body.manager?.role === "owner") body.idleMs = 1500;
    await route.fulfill({ response, json: body });
  });
}
