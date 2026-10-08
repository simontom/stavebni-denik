import { expect, test, type Page } from "@playwright/test";
import { ADMIN_NICKNAME, ADMIN_PASSWORD } from "./global-setup";

async function loginAndCreateProject(page: Page): Promise<string> {
  await page.goto("/login");
  await page.locator('input[name="nickname"]').fill(ADMIN_NICKNAME);
  await page.locator('input[name="password"]').fill(ADMIN_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 });

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
