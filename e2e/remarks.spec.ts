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
  await page.locator('input[name="name"]').fill(`E2E Remarks ${Date.now()}`);
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

test("the manager records an entry of an outside party, also after signing, and it can never be changed", async ({ page }) => {
  test.setTimeout(90_000);
  await login(page);
  const projectUrl = await createProject(page);
  const day = pragueToday();

  await page.goto(`${projectUrl}/reports/${day}`);
  await page.locator('textarea[name="workDescription"]').fill("Betonáž stropu");
  const saved = page.waitForResponse((r) => r.request().method() === "POST" && r.url().includes(`/reports/${day}`));
  await page.getByRole("button", { name: /vytvořit záznam/i }).click();
  expect((await saved).ok()).toBeTruthy();

  // Sign: after that the entry itself is locked, but entries of other parties are still possible.
  await page.getByRole("button", { name: /podepsat a uzamknout/i }).click();
  const signDialog = page.getByRole("dialog", { name: /podepsat a uzamknout záznam/i });
  await signDialog.getByLabel("Heslo").fill(ADMIN_PASSWORD);
  await signDialog.getByRole("button", { name: "Podepsat", exact: true }).click();
  await expect(page.getByText("Podepsáno", { exact: true })).toBeVisible({ timeout: 15_000 });

  const section = page.getByRole("region", { name: "Zápisy dalších osob" });
  await expect(section).toBeVisible({ timeout: 15_000 });
  await expect(section.getByText(/zatím nikdo další nezapsal/i)).toBeVisible();

  // The manager has to name the party the entry is for; nothing can be sent without it.
  const add = section.getByRole("button", { name: "Přidat zápis" });
  await section.locator('textarea[name="remarkText"]').fill("Při kontrole nebyly zjištěny nedostatky.");
  await expect(add).toBeDisabled();
  await section.locator('input[name="remarkAuthor"]').fill("Stavební úřad Brno, Ing. Novák");
  await expect(add).toBeEnabled();
  const posted = page.waitForResponse((r) => r.request().method() === "POST" && r.url().includes("/remarks"));
  await add.click();
  expect((await posted).status()).toBe(201);

  await expect(section.getByText("Při kontrole nebyly zjištěny nedostatky.")).toBeVisible();
  await expect(section.getByText(/Stavební úřad Brno, Ing\. Novák \(zapsal/)).toBeVisible();
  await expect(section.getByRole("button", { name: /upravit|smazat|odstranit/i })).toHaveCount(0);

  await page.reload();
  await expect(page.getByRole("region", { name: "Zápisy dalších osob" }).getByText("Při kontrole nebyly zjištěny nedostatky.")).toBeVisible({ timeout: 15_000 });
});
