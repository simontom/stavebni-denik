import { expect, test } from "@playwright/test";

/**
 * Authenticated smoke for the admin/users management area. Exercises:
 *
 *   1. login jako e2e-admin (account upsertnutý v globalSetup),
 *   2. /admin/users — vytvoření nového usera,
 *   3. /admin/users — editace usera (displayName),
 *   4. /admin/users — deaktivace + reaktivace,
 *   5. /admin/users — smazání (soft-delete) usera,
 *   6. admin nav linky viditelné.
 *
 * Předpoklad: globalSetup upsertne `e2e-admin` s heslem
 * `E2E-Adm1n!Pass#2026` a smaže předchozí `e2e-worker`. Spec běží
 * proti REAL local server (BASE_URL nebo `pnpm dev` přes webServer).
 */

const ADMIN_NICKNAME = "e2e-admin";
const ADMIN_PASSWORD = "E2E-Adm1n!Pass#2026";
test("admin login + create + edit + deactivate + delete user", async ({
  page,
}) => {
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
  // CardTitle je <div>, ne <h1> — použít text match.
  await expect(page.getByText("Uživatelé", { exact: true }).first()).toBeVisible();

  // --- 3) Vytvořit nového usera ----------------------------------------
  await page.getByRole("button", { name: /nový uživatel/i }).click();
  await page.locator('input[name="nickname"]').fill(WORKER_NICKNAME);
  await page.locator('input[name="displayName"]').fill(WORKER_DISPLAY);
  await page.getByRole("button", { name: /^vytvořit$/i }).click();
  // Po úspěšném vytvoření se objeví "Předejte tyto údaje uživateli ..."
  await expect(
    page.getByText(/předejte tyto údaje uživateli/i),
  ).toBeVisible({ timeout: 10_000 });
  // Confirm "heslo se po zavření nezobrazí" je window.confirm — accept.
  // Pak klik na Zrušit (nebo X) zavře dialog.
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: /^hotovo$/i }).click();

  // Worker se objevil v tabulce — kontroluj nickname (unique).
  const workerRow = page.locator("tr", { hasText: WORKER_NICKNAME });
  await expect(workerRow).toBeVisible({ timeout: 10_000 });
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
  page.once("dialog", (d) => d.accept());
  await workerRow.getByRole("button", { name: /deaktivovat/i }).click();
  await expect(workerRow.getByText(/deaktivován/i)).toBeVisible({
    timeout: 15_000,
  });

  page.once("dialog", (d) => d.accept());
  await workerRow.getByRole("button", { name: /aktivovat/i }).click();
  await expect(workerRow.getByText(/aktivní|přihlášení/i)).toBeVisible({
    timeout: 15_000,
  });

  // --- 6) Smazat usera --------------------------------------------------
  page.once("dialog", (d) => d.accept());
  await workerRow.getByRole("button", { name: /smazat/i }).click();
  await expect(page.locator("tr", { hasText: WORKER_NICKNAME })).toHaveCount(
    0,
    { timeout: 10_000 },
  );
});

test("admin nav links (Uživatelé + Audit log) visible after login", async ({
  page,
}) => {
  await page.goto("/login");
  await page.locator('input[name="nickname"]').fill(ADMIN_NICKNAME);
  await page.locator('input[name="password"]').fill(ADMIN_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 });

  // Konkrétně header nav (ne dashboard card).
  const header = page.getByRole("navigation", { name: /hlavní/i });
  await expect(
    header.getByRole("link", { name: "Uživatelé", exact: true }),
  ).toBeVisible();
  await expect(
    header.getByRole("link", { name: "Audit log", exact: true }),
  ).toBeVisible();
});

