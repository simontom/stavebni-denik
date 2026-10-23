import { expect, test, type Page } from "@playwright/test";
import { ADMIN_NICKNAME, ADMIN_PASSWORD } from "./global-setup";
import { chooseSiteManager, selectByText } from "./helpers";

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

/**
 * Signature format 3 (backlog C2), as a person meets it: the author's supervision of the project, the scope of a manager, and
 * the start and interruption of work are entered; the signature then stores the signer and part A, and the entry page says that
 * the signer it shows is the one stored when the entry was signed. (What a rename of the signer or a change of the project does
 * afterwards, and what the PDF prints, is covered by the backend tests, which can change an account behind the application.)
 */
test("the author's supervision, a member's scope and the start of work are entered, and the signature reports the signer as stored", async ({ page }) => {
  test.setTimeout(150_000);
  await login(page);

  // The project, with the author's supervision.
  await page.goto("/projects/new");
  await page.locator('input[name="name"]').fill(`E2E Signature 3 ${Date.now()}`);
  await page.locator('input[name="address"]').fill("Zelená 1, Brno");
  await page.locator('input[name="cadastralArea"]').fill("Brno-střed");
  await page.locator('input[name="parcelNumbers"]').fill("12/3");
  await page.locator('input[name="builder"]').fill("Stavebník a.s.");
  await page.locator('input[name="contractor"]').fill("Zhotovitel s.r.o.");
  await page.locator('input[name="authorSupervisionName"]').fill("Ing. arch. Petr Dozor");
  await page.locator('input[name="authorSupervisionAuthorization"]').fill("ČKA 00 123");
  await chooseSiteManager(page, ADMIN_NICKNAME);
  await page.getByRole("button", { name: /založit zakázku/i }).click();
  await expect(page).toHaveURL(/\/projects\/[0-9a-fA-F-]{36}$/);
  const projectUrl = page.url();

  await expect(page.getByText("Ing. arch. Petr Dozor, autorizace ČKA 00 123")).toBeVisible({ timeout: 15_000 });
  await page.getByRole("link", { name: /upravit údaje o stavbě/i }).click();
  await expect(page.locator('input[name="authorSupervisionName"]')).toHaveValue("Ing. arch. Petr Dozor", { timeout: 15_000 });
  await expect(page.locator('input[name="authorSupervisionAuthorization"]')).toHaveValue("ČKA 00 123");

  // A second manager of the project, with the scope of their authorisation and responsibility.
  await page.goto(`${projectUrl}?tab=members`);
  await selectByText(page.getByLabel("Uživatel", { exact: true }), /manager@stavebni-denik\.cz/);
  const scope = page.getByLabel("Rozsah oprávnění a odpovědnosti");
  await expect(scope).toBeVisible();
  await scope.fill("Zástupce stavbyvedoucího, objekty SO 02 a SO 03");
  await page.getByRole("button", { name: "Přidat", exact: true }).click();
  await expect(page.locator("table").getByText("Zástupce stavbyvedoucího, objekty SO 02 a SO 03")).toBeVisible({ timeout: 15_000 });
  // The scope is kept when the page is loaded again.
  await page.reload();
  await expect(page.locator("table").getByText("Zástupce stavbyvedoucího, objekty SO 02 a SO 03")).toBeVisible({ timeout: 15_000 });

  // The entry, with the start and interruption of work (příloha 12 B.2 b)).
  const day = pragueToday();
  await page.goto(`${projectUrl}/reports/${day}`);
  await page.locator('textarea[name="workDescription"]').fill("Betonáž základové desky");
  await page.locator('textarea[name="detail-workStateChanges"]').fill("Práce zahájeny 28. 9., přerušeny 3. 10. pro déšť");
  const saved = page.waitForResponse((r) => r.request().method() === "POST" && r.url().includes(`/reports/${day}`));
  await page.getByRole("button", { name: /uložit (záznam|změny)/i }).click();
  expect((await saved).ok()).toBeTruthy();

  await page.getByRole("button", { name: /podepsat a uzamknout/i }).click();
  const dialog = page.getByRole("dialog", { name: /podepsat a uzamknout záznam/i });
  await dialog.getByLabel("Heslo").fill(ADMIN_PASSWORD);
  await dialog.getByRole("button", { name: "Podepsat", exact: true }).click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });
  await expect(page.getByText("Podepsáno", { exact: true })).toBeVisible({ timeout: 15_000 });

  // The text is kept with the signed entry.
  await page.reload();
  await expect(page.getByText("Práce zahájeny 28. 9., přerušeny 3. 10. pro déšť")).toBeVisible({ timeout: 15_000 });
  // ... and the signer is on the page without a click: the one stored when the entry was signed
  await expect(page.getByRole("region", { name: "Podpis záznamu" }).getByText(/E2E Admin, ČKAIT 0000000/)).toBeVisible();

  // The check says the signer is the one that was stored when the entry was signed, not what the account says today.
  await page.getByRole("button", { name: /ověřit podpis/i }).click();
  await expect(page.getByRole("status")).toContainText(/Obsah odpovídá podpisu/, { timeout: 15_000 });
  await expect(page.getByRole("status")).toContainText(/jméno a číslo uložené při podpisu/);
  await expect(page.getByRole("status")).toContainText(/ČKAIT 0000000/);
});
