import { expect, test, type Page } from "@playwright/test";
import { ADMIN_NICKNAME, ADMIN_PASSWORD } from "./global-setup";

/** A date in Prague, today, as YYYY-MM-DD. */
function pragueToday(): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Prague" }).format(new Date());
}

async function login(page: Page) {
  await page.goto("/login");
  await page.locator('input[name="nickname"]').fill(ADMIN_NICKNAME);
  await page.locator('input[name="password"]').fill(ADMIN_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 });
}

async function createProject(page: Page): Promise<string> {
  await page.goto("/projects/new");
  await page.locator('input[name="name"]').fill(`E2E Signature ${Date.now()}`);
  await page.locator('input[name="address"]').fill("E2E Street 1");
  await page.locator('input[name="cadastralArea"]').fill("E2E Area");
  await page.locator('input[name="parcelNumbers"]').fill("1/1");
  await page.locator('input[name="builder"]').fill("Builder a.s.");
  await page.locator('input[name="contractor"]').fill("Contractor s.r.o.");
  await page.locator('button[id="siteManagerId"]').click();
  await page.getByRole("option", { name: new RegExp(ADMIN_NICKNAME) }).click();
  await page.getByRole("button", { name: /založit zakázku/i }).click();
  await expect(page).toHaveURL(/\/projects\/[0-9a-fA-F-]{36}/);
  return page.url().split("?")[0];
}

test("signing asks for the password, a wrong one signs nothing, and the signature can be checked", async ({ page }) => {
  test.setTimeout(90_000);
  await login(page);
  const projectUrl = await createProject(page);
  const day = pragueToday();

  await page.goto(`${projectUrl}/reports/${day}`);
  await page.locator('textarea[name="workDescription"]').fill("Betonáž základové desky");
  const saved = page.waitForResponse((r) => r.request().method() === "POST" && r.url().includes(`/reports/${day}`));
  await page.getByRole("button", { name: /vytvořit záznam/i }).click();
  expect((await saved).ok()).toBeTruthy();

  const dialog = page.getByRole("dialog", { name: /podepsat a uzamknout záznam/i });
  await page.getByRole("button", { name: /podepsat a uzamknout/i }).click();
  await expect(dialog).toBeVisible();

  // Nothing to submit without a password; a wrong one is refused in the dialog (and it is not a lapsed session).
  await expect(dialog.getByRole("button", { name: "Podepsat", exact: true })).toBeDisabled();
  await dialog.getByLabel("Heslo").fill("Not-The-Password-1!");
  await dialog.getByRole("button", { name: "Podepsat", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText(/heslo není správné/i, { timeout: 15_000 });
  await expect(page.getByRole("dialog", { name: /přihlášení vypršelo/i })).toHaveCount(0);
  await expect(page.getByText("Podepsáno", { exact: true })).toHaveCount(0);
  // A draft has no number: it is given at signing, so the sequence of signed entries has no gaps.
  await expect(page.getByText(/Záznam č\. \d/)).toHaveCount(0);

  // The right one signs and locks.
  await dialog.getByLabel("Heslo").fill(ADMIN_PASSWORD);
  await dialog.getByRole("button", { name: "Podepsat", exact: true }).click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });
  await expect(page.getByText("Podepsáno", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Záznam č. 1", { exact: true })).toBeVisible({ timeout: 15_000 });

  // The page shows what the signature covers and can check it against the entry as it is now.
  await expect(page.getByText(/Otisk obsahu \(SHA-256\)/)).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: /ověřit podpis/i }).click();
  await expect(page.getByRole("status")).toContainText(/Obsah odpovídá podpisu/, { timeout: 15_000 });
  await expect(page.getByRole("status")).toContainText(/ČKAIT/);
});
