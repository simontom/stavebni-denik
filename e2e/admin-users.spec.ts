import { expect, test } from "@playwright/test";
import { ADMIN_NICKNAME, ADMIN_PASSWORD } from "./global-setup";
test("admin login + create + edit + deactivate + delete user", async ({ page }) => {
  const runId = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  const WORKER_NICKNAME = `e2e-worker-${runId}`;
  const WORKER_DISPLAY = "E2E Worker";
  const WORKER_DISPLAY_EDITED = "E2E Worker (upraveno)";

  // --- 1) Login --------------------------------------------------------
  await page.goto("/login");
  await page.locator('input[name="nickname"]').fill(ADMIN_NICKNAME);
  await page.locator('input[name="password"]').fill(ADMIN_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 });

  // --- 2) Navigovat na /admin/users ------------------------------------
  await page.goto("/admin/users");
  await page.waitForLoadState("networkidle");
  // CardTitle je <div>, ne <h1> — použít text match.
  await expect(page.getByText("Uživatelé", { exact: true }).first()).toBeVisible();

  // --- 3) Vytvořit nového usera ----------------------------------------
  await page.getByRole("button", { name: /nový uživatel/i }).click();
  await page.locator('input[name="nickname"]').fill(WORKER_NICKNAME);
  await page.locator('input[name="displayName"]').fill(WORKER_DISPLAY);
  await page.getByRole("button", { name: /^vytvořit$/i }).click();
  // Po úspěšném vytvoření se objeví "Předejte tyto údaje uživateli ..."
  await expect(page.getByText(/předejte tyto údaje uživateli/i)).toBeVisible({ timeout: 15_000 });
  // Dialog s heslem jde zavřít, až když osoba potvrdí, že heslo předala (není to window.confirm).
  await page.getByLabel("Heslo jsem předal(a)").check();
  await page.getByRole("button", { name: /^hotovo$/i }).click();

  // Worker se objevil v tabulce — kontroluj nickname (unique).
  const workerRow = page.locator("tr", { hasText: WORKER_NICKNAME });
  await expect(workerRow).toBeVisible({ timeout: 15_000 });
  await expect(workerRow.getByText(WORKER_DISPLAY)).toBeVisible();

  // --- 4) Editovat usera -----------------------------------------------
  await workerRow.getByRole("button", { name: /upravit/i }).click();

  const editDialog = page.getByRole("dialog");
  await editDialog.getByLabel("Jméno a příjmení").fill(WORKER_DISPLAY_EDITED);
  await editDialog.getByRole("button", { name: /uložit změny/i }).click();

  await expect(page.locator("tr", { hasText: WORKER_DISPLAY_EDITED })).toBeVisible({
    timeout: 15_000,
  });

  // --- 5) Deaktivovat / reaktivovat ------------------------------------
  // Každá akce se ptá v dialogu aplikace; sloveso je na tlačítku.
  await workerRow.getByRole("button", { name: /deaktivovat/i }).click();
  await page.getByRole("dialog", { name: "Deaktivovat uživatele?" }).getByRole("button", { name: "Deaktivovat", exact: true }).click();
  await expect(workerRow.getByText(/deaktivován/i)).toBeVisible({
    timeout: 15_000,
  });

  await workerRow.getByRole("button", { name: /aktivovat/i }).click();
  await page.getByRole("dialog", { name: "Aktivovat uživatele?" }).getByRole("button", { name: "Aktivovat", exact: true }).click();
  await expect(workerRow.getByText(/aktivní|přihlášení/i)).toBeVisible({
    timeout: 15_000,
  });

  // --- 6) Smazat usera --------------------------------------------------
  await workerRow.getByRole("button", { name: /smazat/i }).click();
  await page.getByRole("dialog", { name: "Smazat uživatele?" }).getByRole("button", { name: "Smazat", exact: true }).click();
  await expect(page.locator("tr", { hasText: WORKER_NICKNAME })).toHaveCount(0, { timeout: 15_000 });
});

test("admin nav links (Uživatelé + Audit) visible after login", async ({ page }) => {
  await page.goto("/login");
  await page.locator('input[name="nickname"]').fill(ADMIN_NICKNAME);
  await page.locator('input[name="password"]').fill(ADMIN_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 });

  // Konkrétně header nav (ne dashboard card).
  const header = page.getByRole("navigation", { name: /hlavní/i });
  await expect(header.getByRole("link", { name: "Uživatelé", exact: true })).toBeVisible();
  await expect(header.getByRole("link", { name: "Audit", exact: true })).toBeVisible();
});
