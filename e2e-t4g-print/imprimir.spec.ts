import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Check 8: tap Imprimir on /next, manager code, 4 tickets on the fake Epson; tap again, 4 CAMBIO. */
function tickets(): Buffer[] {
  const raw = readFileSync(join(process.env.T4G_PRINT_E2E_ROOT!, "tickets.jsonl"), "utf8");
  return raw.split("\n").filter(Boolean).map((l) => Buffer.from((JSON.parse(l) as { hex: string }).hex, "hex"));
}

test("Imprimir prints 4 tickets, then Reimprimir prints 4 marked CAMBIO", async ({ page }) => {
  await page.goto("/next");
  await page.getByTestId("next-card-AgIeZY").click();
  const button = page.getByTestId("t4g-print-button");
  await expect(button).toHaveText(/Imprimir/);

  await button.click();
  await page.getByTestId("manager-code-input").fill("2468");
  await page.getByTestId("manager-unlock-submit").click();
  await expect(page.getByTestId("t4g-print-notice")).toHaveText(
    "Enviado a la impresora morada. Revisa que salieron 4 tickets.",
  );
  await expect.poll(() => tickets().length).toBe(4);
  await expect(button).toHaveText(/Reimprimir \(CAMBIO\)/);

  await button.click(); // the token is still held; no second code prompt
  await expect.poll(() => tickets().length).toBe(8);
  for (const t of tickets().slice(4)) expect(t.includes(Buffer.from("** CAMBIO **", "latin1"))).toBe(true);
  for (const t of tickets().slice(0, 4)) expect(t.includes(Buffer.from("CAMBIO", "latin1"))).toBe(false);
});
