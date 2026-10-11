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
  await page.locator('input[name="name"]').fill(`E2E Session ${Date.now()}`);
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

test("a session that ends while an entry is being written does not lose the text", async ({ page }) => {
  test.setTimeout(90_000);
  await login(page);
  const projectUrl = await createProject(page);
  const day = pragueToday();
  const description = page.locator('textarea[name="workDescription"]');
  const dialog = page.getByRole("dialog", { name: /přihlášení vypršelo/i });

  await page.goto(`${projectUrl}/reports/${day}`);
  await expect(description).toBeVisible({ timeout: 15_000 });
  await description.fill("Betonáž stropu, první polovina");

  // The session ends (the cookie is gone, as after the 12 hours or a logout elsewhere).
  await page.context().clearCookies();
  await page.getByRole("button", { name: /vytvořit záznam/i }).click();

  // The page is not thrown away: a dialog asks for the password, and the text is still there.
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  await expect(page).toHaveURL(new RegExp(`/reports/${day}$`));
  await expect(description).toHaveValue("Betonáž stropu, první polovina");

  // A wrong password is refused and the dialog stays.
  await dialog.getByLabel("Heslo").fill("Not-The-Password-1!");
  await dialog.getByRole("button", { name: /přihlásit se/i }).click();
  await expect(dialog.getByRole("alert")).toContainText(/neplatné heslo/i, { timeout: 15_000 });
  await expect(description).toHaveValue("Betonáž stropu, první polovina");

  // The right one closes it, and saving again works with what was typed.
  await dialog.getByLabel("Heslo").fill(ADMIN_PASSWORD);
  await dialog.getByRole("button", { name: /přihlásit se/i }).click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });
  await expect(description).toHaveValue("Betonáž stropu, první polovina");

  const saved = page.waitForResponse((r) => r.request().method() === "POST" && r.url().includes(`/reports/${day}`));
  await page.getByRole("button", { name: /vytvořit záznam/i }).click();
  expect((await saved).ok()).toBeTruthy();

  await page.goto(`${projectUrl}/reports/${day}`);
  await expect(description).toHaveValue("Betonáž stropu, první polovina", { timeout: 15_000 });
});

test("a page that cannot load because the session ended offers the sign-in and then loads", async ({ page }) => {
  await login(page);
  await expect(page).toHaveURL(/\/projects/);

  await page.context().clearCookies();
  await page.reload();

  const dialog = page.getByRole("dialog", { name: /přihlášení vypršelo/i });
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  await dialog.getByLabel("Heslo").fill(ADMIN_PASSWORD);
  await dialog.getByRole("button", { name: /přihlásit se/i }).click();

  // Nothing was typed, so the page loads again by itself.
  await expect(dialog).toBeHidden({ timeout: 15_000 });
  await expect(page.getByRole("heading", { name: /projekty|zakázky/i }).first()).toBeVisible({ timeout: 15_000 });
});

test("leaving from the dialog goes to the login page", async ({ page }) => {
  await login(page);
  await page.context().clearCookies();
  await page.reload();

  const dialog = page.getByRole("dialog", { name: /přihlášení vypršelo/i });
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  await dialog.getByRole("button", { name: /odhlásit/i }).click();

  await expect(page).toHaveURL(/\/login/, { timeout: 15_000 });
});
