import { expect, test, type Page } from "@playwright/test";
import { ADMIN_NICKNAME, ADMIN_PASSWORD } from "./global-setup";

async function login(page: Page) {
  await page.goto("/login");
  await page.locator('input[name="nickname"]').fill(ADMIN_NICKNAME);
  await page.locator('input[name="password"]').fill(ADMIN_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 });
}

test("the identification of a project is entered, changed by its manager, and a change made meanwhile is not overwritten", async ({ page }) => {
  test.setTimeout(120_000);
  await login(page);

  // Entered when the project is created.
  await page.goto("/projects/new");
  await page.locator('input[name="name"]').fill(`E2E Identification ${Date.now()}`);
  await page.locator('input[name="address"]').fill("Karlova 15, Brno");
  await page.locator('input[name="cadastralArea"]').fill("Brno-střed");
  // A long list of parcels (more than 200 characters, the server allows 500) is neither cut nor refused.
  const parcels = Array.from({ length: 40 }, (_, i) => `450/${i + 1}`).join(", ");
  await page.locator('input[name="parcelNumbers"]').fill(parcels);
  await page.locator('input[name="builder"]').fill("Město Brno");
  await page.locator('input[name="contractor"]').fill("Stavitel a.s.");
  await page.locator('input[name="permitNumber"]').fill("SZ/2026/123");
  await page.locator('input[name="permitDate"]').fill("2026-03-01");
  await page.locator('input[name="designerName"]').fill("Ing. Petr Projektant, Ph.D.");
  await page.locator('input[name="tdsName"]').fill("Jan Dozor");
  await page.locator('input[name="bozpName"]').fill("Eva Bozp");
  await page.locator('textarea[name="subcontractors"]').fill("Elektro s.r.o.\nVodoinstalace s.r.o.");
  await page.locator('textarea[name="supportingDocuments"]').fill("Smlouva o dílo č. SML-1");
  await page.locator('button[id="siteManagerId"]').click();
  await page.getByRole("option", { name: new RegExp(ADMIN_NICKNAME) }).click();
  await page.getByRole("button", { name: /založit zakázku/i }).click();
  await expect(page).toHaveURL(/\/projects\/[0-9a-fA-F-]{36}$/);
  const projectUrl = page.url();

  // The project page shows it.
  await expect(page.getByText("SZ/2026/123 ze dne 2026-03-01")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(parcels)).toBeVisible();
  await expect(page.getByText("Ing. Petr Projektant, Ph.D.")).toBeVisible();
  await expect(page.getByText("Jan Dozor")).toBeVisible();
  await expect(page.getByText("Elektro s.r.o.")).toBeVisible();
  await expect(page.getByText("Smlouva o dílo č. SML-1")).toBeVisible();

  // Its manager changes it.
  await page.getByRole("link", { name: /upravit údaje o stavbě/i }).click();
  await expect(page).toHaveURL(/\/edit$/);
  await expect(page.locator('input[name="permitNumber"]')).toHaveValue("SZ/2026/123", { timeout: 15_000 });
  await expect(page.locator('input[name="permitDate"]')).toHaveValue("2026-03-01");
  await page.locator('input[name="address"]').fill("Nová 1, Brno");
  await page.locator('textarea[name="supportingDocuments"]').fill("Smlouva o dílo č. SML-1\nStavební povolení SZ/2026/123");
  await page.getByRole("button", { name: /uložit změny/i }).click();
  await expect(page).toHaveURL(projectUrl, { timeout: 15_000 });
  await expect(page.getByText("Nová 1, Brno").first()).toBeVisible();
  await expect(page.getByText("Stavební povolení SZ/2026/123")).toBeVisible();

  // Two people editing: the one who saves second is told instead of overwriting the first.
  await page.goto(`${projectUrl}/edit`);
  await expect(page.locator('input[name="address"]')).toHaveValue("Nová 1, Brno", { timeout: 15_000 });
  const other = await page.context().newPage();
  await other.goto(`${projectUrl}/edit`);
  await expect(other.locator('input[name="address"]')).toHaveValue("Nová 1, Brno", { timeout: 15_000 });
  await other.locator('input[name="address"]').fill("Od druhého 2, Brno");
  await other.getByRole("button", { name: /uložit změny/i }).click();
  await expect(other).toHaveURL(projectUrl, { timeout: 15_000 });

  await page.locator('input[name="designerName"]').fill("Jiný projektant");
  await page.getByRole("button", { name: /uložit změny/i }).click();
  await expect(page.getByRole("alert")).toContainText(/mezitím změnil/i, { timeout: 15_000 });
  await expect(page.getByRole("button", { name: /načíst aktuální verzi/i })).toBeVisible();
  // What the second person saved is still there.
  await page.goto(projectUrl);
  await expect(page.getByText("Od druhého 2, Brno").first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Jiný projektant")).toHaveCount(0);
});
