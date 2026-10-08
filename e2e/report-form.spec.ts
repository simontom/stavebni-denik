import { expect, test, type Page } from "@playwright/test";
import { ADMIN_NICKNAME, ADMIN_PASSWORD } from "./global-setup";

async function login(page: Page) {
  await page.goto("/login");
  await page.locator('input[name="nickname"]').fill(ADMIN_NICKNAME);
  await page.locator('input[name="password"]').fill(ADMIN_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 });
}

async function loginAndCreateProject(page: Page): Promise<string> {
  await login(page);

  await page.goto("/projects/new");
  await page.locator('input[name="name"]').fill(`E2E Form ${Date.now()}`);
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

test("a new entry starts empty and an entry that could not be loaded cannot be saved", async ({ page }) => {
  const projectUrl = await loginAndCreateProject(page);
  const projectId = projectUrl.split("/").pop()!;

  // A day without an entry: the form is empty (no invented text, trade or head count) and can be saved.
  await page.goto(`${projectUrl}/reports/2026-09-28`);
  await expect(page.locator('textarea[name="workDescription"]')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('textarea[name="workDescription"]')).toHaveValue("");
  await expect(page.locator('input[name="workerTrade"]').first()).toHaveValue("");
  await expect(page.getByRole("button", { name: /vytvořit záznam/i })).toBeEnabled();

  // The entry cannot be loaded (server error): saving is blocked, so an empty form cannot overwrite it.
  await page.route(`**/api/projects/${projectId}/reports/2026-09-29`, (route) =>
    route.request().method() === "GET" ? route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"boom"}' }) : route.continue(),
  );
  await page.goto(`${projectUrl}/reports/2026-09-29`);
  await expect(page.getByText(/nepodařilo načíst/i)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: /vytvořit záznam/i })).toBeDisabled();
});

test("two people editing the same entry: the second save is refused and offers the other version", async ({ browser, page, baseURL }) => {
  test.setTimeout(90_000);
  const projectUrl = await loginAndCreateProject(page);
  const reportUrl = `${projectUrl}/reports/2026-09-28`;
  const description = page.locator('textarea[name="workDescription"]');
  const save = (p: Page) => p.getByRole("button", { name: /vytvořit záznam/i });

  // Person A creates the entry.
  await page.goto(reportUrl);
  await expect(description).toBeVisible({ timeout: 15_000 });
  await description.fill("Verze osoby A");
  const created = page.waitForResponse((r) => r.request().method() === "POST" && r.url().includes("/reports/2026-09-28"));
  await save(page).click();
  expect((await created).ok()).toBeTruthy();

  // Person B opens the same entry (in another session) and sees A's text.
  const other = await browser.newContext({ baseURL });
  const pageB = await other.newPage();
  await login(pageB);
  await pageB.goto(reportUrl);
  const descriptionB = pageB.locator('textarea[name="workDescription"]');
  await expect(descriptionB).toHaveValue("Verze osoby A", { timeout: 15_000 });

  // A saves a change; B, still holding the old version, writes something else and saves.
  await description.fill("Verze osoby A, doplněno");
  const changed = page.waitForResponse((r) => r.request().method() === "POST" && r.url().includes("/reports/2026-09-28"));
  await save(page).click();
  expect((await changed).ok()).toBeTruthy();

  await descriptionB.fill("Verze osoby B");
  await save(pageB).click();
  await expect(pageB.getByRole("alert")).toContainText(/změnil někdo jiný/i, { timeout: 15_000 });
  await expect(pageB.getByRole("button", { name: /načíst aktuální verzi/i })).toBeVisible();

  // Nothing was overwritten: reloading shows A's latest text.
  await pageB.getByRole("button", { name: /načíst aktuální verzi/i }).click();
  await expect(descriptionB).toHaveValue("Verze osoby A, doplněno", { timeout: 15_000 });
  await other.close();
});
