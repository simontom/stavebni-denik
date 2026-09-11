import { expect, test } from "@playwright/test";
import { ADMIN_NICKNAME, ADMIN_PASSWORD } from "./global-setup";

test.describe("Legislative Compliance", () => {
  test("investor acknowledge and legislative fields", async ({ page }) => {
    test.setTimeout(180_000);
    // 1. Login
    await page.goto("/login");
    await page.locator('input[name="nickname"]').fill(ADMIN_NICKNAME);
    await page.locator('input[name="password"]').fill(ADMIN_PASSWORD);
    await page.getByRole('button', { name: /přihlásit se/i }).click();
    await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 });
    
    // 2. Create Project with legislative fields
    await page.goto("/projects/new");
    await page.locator('input[name="name"]').fill("Legislative Project");
    await page.locator('input[name="address"]').fill("Leg 1");
    await page.locator('input[name="cadastralArea"]').fill("Leg Area");
    await page.locator('input[name="parcelNumbers"]').fill("123");
    await page.locator('input[name="builder"]').fill("B");
    await page.locator('input[name="contractor"]').fill("C");
    await page.locator('button[id="siteManagerId"]').click();
    await page.getByRole('option', { name: new RegExp(ADMIN_NICKNAME) }).click();
    
    await page.locator('input[name="contractNumber"]').fill("SML-123");
    await page.locator('input[name="contractDate"]').fill("2026-09-01");
    await page.locator('input[name="designDocVersion"]').fill("v1.2");
    await page.locator('input[name="designDocDate"]').fill("2026-08-15");
    
    await page.getByRole('button', { name: /založit/i }).click();
    
    // 3. Verify Project Details
    await expect(page).toHaveURL(/\/projects\/.+/);
    await expect(page.getByText("SML-123")).toBeVisible();
    await expect(page.getByText("v1.2")).toBeVisible();
    
    // 4. Create Daily Report with control day and SO
    await page.getByRole('link', { name: /^Záznamy$/i }).click();
    await page.locator('input[id="new-report-date"]').fill("2026-09-11");
    await page.getByRole('button', { name: /otevřít den/i }).click();
    
    await expect(page).toHaveURL(/\/projects\/.+\/reports\/.+/);
    await page.locator('input[name="isControlDay"]').check();
    await page.locator('input[name="constructionObj"]').fill("SO-101");
    await page.locator('textarea[name="workDescription"]').fill("Práce na SO-101");
    await page.getByRole('button', { name: /vytvořit záznam/i }).click();
    
    // 5. Verify Report Details
    await expect(page.getByText("Kontrolní den")).toBeVisible();
    await expect(page.getByText("SO: SO-101")).toBeVisible();
  });
});
