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
  await page.locator('input[name="name"]').fill(`E2E Addenda ${Date.now()}`);
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

test("a signed entry is corrected by addenda, which can be added but never edited or removed", async ({ page }) => {
  test.setTimeout(90_000);
  await login(page);
  const projectUrl = await createProject(page);
  const day = pragueToday();
  const description = page.locator('textarea[name="workDescription"]');

  await page.goto(`${projectUrl}/reports/${day}`);
  await description.fill("Betonáž stropu, první polovina");
  const saved = page.waitForResponse((r) => r.request().method() === "POST" && r.url().includes(`/reports/${day}`));
  await page.getByRole("button", { name: /vytvořit záznam/i }).click();
  expect((await saved).ok()).toBeTruthy();

  // While the entry is being written there is no place for an addendum: it is edited directly.
  await expect(page.getByRole("heading", { name: "Dodatky" })).toHaveCount(0);

  await page.getByRole("button", { name: /podepsat a uzamknout/i }).click();
  const signDialog = page.getByRole("dialog", { name: /podepsat a uzamknout záznam/i });
  await signDialog.getByLabel("Heslo").fill(ADMIN_PASSWORD);
  await signDialog.getByRole("button", { name: "Podepsat", exact: true }).click();
  await expect(page.getByText("Podepsáno", { exact: true })).toBeVisible({ timeout: 15_000 });

  // Signed: the text is locked, and the addenda section appears.
  await expect(description).toBeDisabled();
  await expect(page.getByRole("heading", { name: "Dodatky" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/zatím není žádný dodatek/i)).toBeVisible();

  const addendum = page.locator('textarea[name="addendumText"]');
  await expect(page.getByRole("button", { name: "Přidat dodatek" })).toBeDisabled();
  await addendum.fill("Oprava: betonáž proběhla ve 14 hodin, ne v 11.");
  const posted = page.waitForResponse((r) => r.request().method() === "POST" && r.url().includes("/addenda"));
  await page.getByRole("button", { name: "Přidat dodatek" }).click();
  expect((await posted).status()).toBe(201);

  // It is listed with its author, the form is empty again, and there is nothing to edit or delete.
  const section = page.getByRole("region", { name: "Dodatky" });
  await expect(section.getByText("Oprava: betonáž proběhla ve 14 hodin, ne v 11.")).toBeVisible();
  await expect(addendum).toHaveValue("");
  await expect(section.getByRole("button", { name: /upravit|smazat|odstranit/i })).toHaveCount(0);

  // After a reload it is still there, below the unchanged entry.
  await page.reload();
  await expect(page.getByRole("region", { name: "Dodatky" }).getByText("Oprava: betonáž proběhla ve 14 hodin, ne v 11.")).toBeVisible({ timeout: 15_000 });
  await expect(description).toHaveValue("Betonáž stropu, první polovina");
});
