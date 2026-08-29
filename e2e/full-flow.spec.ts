import { expect, test } from "@playwright/test";
import path from "node:path";
import { ADMIN_NICKNAME, ADMIN_PASSWORD } from "./global-setup";

test.describe("Full E2E flow", () => {
  test("creates project, report, photo, signs and generates PDF", async ({ page }) => {
    test.setTimeout(90_000);
    // 1. Login
    await page.goto("/login");
    await page.locator('input[name="nickname"]').fill(ADMIN_NICKNAME);
    await page.locator('input[name="password"]').fill(ADMIN_PASSWORD);
    await page.getByRole('button', { name: /přihlásit se/i }).click();
    await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 });
    await page.goto("/projects");
    await expect(page).toHaveURL("/projects");

    // 2. Create Project
    await page.locator('a[href="/projects/new"]').click();
    await expect(page).toHaveURL("/projects/new");
    await page.locator('input[name="name"]').fill("E2E Test Project");
    await page.locator('input[name="address"]').fill("E2E Street 1");
    await page.locator('input[name="cadastralArea"]').fill("E2E Area");
    await page.locator('input[name="parcelNumbers"]').fill("123/4");
    await page.locator('input[name="builder"]').fill("Builder a.s.");
    await page.locator('input[name="contractor"]').fill("Contractor s.r.o.");
    
    // Select site manager
    await page.locator('button[id="siteManagerId"]').click();
    await page.getByRole('option', { name: new RegExp(ADMIN_NICKNAME) }).click();
    
    // Submit project form
    await page.getByRole('button', { name: /založit zakázku/i }).click();
    
    // Wait for redirect to project page: /projects/[cuid]
    await expect(page).toHaveURL(/\/projects\/c[a-z0-9]+/);
    const projectUrl = page.url();

    // Navigate to Reports tab
    await page.goto(`${projectUrl}?tab=reports`);
    await expect(page).toHaveURL(/tab=reports/);
    
    // 3. Create Daily Report
    await page.getByRole('button', { name: /Nový pro dnešek/i }).click();
    
    // Wait for the report form page
    await expect(page).toHaveURL(/\/projects\/c[a-z0-9]+\/reports\/\d{4}-\d{2}-\d{2}$/, { timeout: 15_000 });
    const reportUrl = page.url();
    await expect(page.locator('textarea[name="workDescription"]')).toBeVisible({ timeout: 15_000 });
    await page.locator('textarea[name="workDescription"]').fill("Did some E2E work.");
    
    // Fill "workersByTrade" which is a dynamic field list
    // The first row should already exist with empty values.
    await page.locator('input[name="workerTrade"]').first().fill("Zedník");
    await page.locator('input[name="workerCount"]').first().fill("2");

    // Wait for the form submission to finish and navigate to the created report view
    const submitResponse = page.waitForResponse(
      (resp) => resp.request().method() === "POST" && resp.url().includes("/reports/"),
    );
    await page.getByRole('button', { name: /vytvořit záznam/i }).click();
    await submitResponse;
    await page.goto(reportUrl);

    // Photo uploader only exists on the report detail view (rendered after successful creation)
    const photoInput = page.locator('input#photo-files');
    await expect(photoInput).toBeAttached({ timeout: 15_000 });

    // 4. Upload photo
    // Target the main file input and trigger the upload button
    const uploadResponse = page.waitForResponse(
      (resp) => resp.url().includes("/api/photos/upload") && resp.status() === 200,
    );
    await photoInput.setInputFiles(path.resolve(__dirname, 'fixtures/dummy-photo.jpg'));
    await expect(page.getByRole('button', { name: /nahrát fotky/i })).toBeEnabled({ timeout: 15_000 });
    await page.getByRole('button', { name: /nahrát fotky/i }).click();
    await uploadResponse;
    
    // Wait for upload to complete and image to appear
    await expect(page.locator('img[alt^="Fotka"]').first()).toBeVisible({ timeout: 15_000 });

    // 5. Sign and lock
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole('button', { name: /podepsat a uzamknout/i }).click();

    // Verify lock badge
    await expect(page.getByText(/^podepsáno$/i)).toBeVisible({ timeout: 15_000 });

    // 6. PDF export
    // Go back to project page records tab
    await page.goto(`${projectUrl}?tab=reports`);
    await expect(page.getByRole('button', { name: /stáhnout pdf/i })).toBeVisible({ timeout: 15_000 });
    
    // Trigger PDF download
    const downloadPromise = page.waitForEvent('download', { timeout: 30_000 });
    await page.getByRole('button', { name: /stáhnout pdf/i }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/.*\.pdf/);
  });
});
