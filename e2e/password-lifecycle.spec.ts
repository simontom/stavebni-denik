import { expect, test, type Page } from "@playwright/test";
import { ADMIN_NICKNAME, ADMIN_PASSWORD } from "./global-setup";

async function login(page: Page, nickname: string, password: string) {
  await page.goto("/login");
  await page.locator('input[name="nickname"]').fill(nickname);
  await page.locator('input[name="password"]').fill(password);
  await page.locator('button[type="submit"]').click();
}

/** Reads the one-time password out of the credentials dialog and closes it. */
async function readAndCloseCredentials(page: Page): Promise<string> {
  const line = await page.locator("strong", { hasText: "Heslo:" }).locator("xpath=..").innerText();
  const password = line.replace("Heslo:", "").trim();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: /^hotovo$/i }).click();
  return password;
}

test("temporary password: forced change, own password afterwards, administrator reset starts over", async ({ browser, page, baseURL }) => {
  test.setTimeout(120_000);
  const runId = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  const NICKNAME = `e2e-pw-${runId}`;
  const OWN_PASSWORD = "E2e-Vlastni-Heslo-1!";

  // --- Administrator creates an account and gets a temporary password -----------------------------
  await login(page, ADMIN_NICKNAME, ADMIN_PASSWORD);
  await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 });
  await page.goto("/admin/users");
  await page.getByRole("button", { name: /nový uživatel/i }).click();
  await page.locator('input[name="nickname"]').fill(NICKNAME);
  await page.locator('input[name="displayName"]').fill("E2E Password User");
  await page.getByRole("button", { name: /^vytvořit$/i }).click();
  await expect(page.getByText(/předejte tyto údaje uživateli/i)).toBeVisible({ timeout: 15_000 });
  const temporaryPassword = await readAndCloseCredentials(page);
  expect(temporaryPassword.length).toBeGreaterThanOrEqual(12);

  // --- The user is confined to the change-password form --------------------------------------------
  const userContext = await browser.newContext({ baseURL });
  const userPage = await userContext.newPage();
  await login(userPage, NICKNAME, temporaryPassword);
  await expect(userPage).toHaveURL(/\/change-password$/, { timeout: 15_000 });
  await expect(userPage.getByText(/dočasné heslo/i)).toBeVisible();
  await userPage.goto("/projects");
  await expect(userPage).toHaveURL(/\/change-password$/, { timeout: 15_000 });

  const submit = userPage.getByRole("button", { name: /^změnit heslo$/i });
  await userPage.locator("#current-password").fill(temporaryPassword);
  await userPage.locator("#new-password").fill("short");
  await userPage.locator("#repeat-password").fill("short");
  await expect(submit).toBeDisabled();
  await userPage.locator("#new-password").fill(OWN_PASSWORD);
  await userPage.locator("#repeat-password").fill("E2e-Jine-Heslo-1!");
  await expect(userPage.getByText(/hesla se neshodují/i)).toBeVisible();
  await expect(submit).toBeDisabled();
  await userPage.locator("#repeat-password").fill(OWN_PASSWORD);
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(userPage).toHaveURL(/\/projects$/, { timeout: 15_000 });

  // --- Afterwards only the own password works -----------------------------------------------------
  await userPage.getByRole("button", { name: /odhlásit se/i }).click();
  await expect(userPage).toHaveURL(/\/login/, { timeout: 15_000 });
  await login(userPage, NICKNAME, temporaryPassword);
  await expect(userPage.getByText(/neplatné přihlašovací jméno nebo heslo/i)).toBeVisible({ timeout: 15_000 });
  await login(userPage, NICKNAME, OWN_PASSWORD);
  await expect(userPage).toHaveURL(/\/projects$/, { timeout: 15_000 });

  // --- Administrator resets the password: the open session ends, a new temporary password is needed --
  await page.goto("/admin/users");
  const row = page.locator("tr", { hasText: NICKNAME });
  await expect(row).toBeVisible({ timeout: 15_000 });
  page.once("dialog", (d) => d.accept());
  await row.getByRole("button", { name: /obnovit heslo/i }).click();
  await expect(page.getByRole("dialog", { name: /nové heslo/i })).toBeVisible({ timeout: 15_000 });
  const resetPassword = await readAndCloseCredentials(page);

  // The old session is dead on the server (not every page reacts to a 401 by itself).
  const oldSessionStatus = await userPage.evaluate(async () => (await fetch("/api/projects")).status);
  expect(oldSessionStatus).toBe(401);
  await login(userPage, NICKNAME, OWN_PASSWORD);
  await expect(userPage.getByText(/neplatné přihlašovací jméno nebo heslo/i)).toBeVisible({ timeout: 15_000 });
  await login(userPage, NICKNAME, resetPassword);
  await expect(userPage).toHaveURL(/\/change-password$/, { timeout: 15_000 });

  // --- Clean up ------------------------------------------------------------------------------------
  await userContext.close();
  page.once("dialog", (d) => d.accept());
  await row.getByRole("button", { name: /smazat/i }).click();
  await expect(page.locator("tr", { hasText: NICKNAME })).toHaveCount(0, { timeout: 15_000 });
});
