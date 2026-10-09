import { expect, test, type Page } from "@playwright/test";
import { ADMIN_NICKNAME, ADMIN_PASSWORD } from "./global-setup";

/** A date in Prague, [offsetDays] from today, as YYYY-MM-DD. */
function pragueDay(offsetDays: number): string {
  const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Prague" }).format(new Date());
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

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
  await page.goto(`${projectUrl}/reports/${pragueDay(0)}`);
  await expect(page.locator('textarea[name="workDescription"]')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('textarea[name="workDescription"]')).toHaveValue("");
  await expect(page.locator('input[name="workerTrade"]').first()).toHaveValue("");
  await expect(page.getByRole("button", { name: /vytvořit záznam/i })).toBeEnabled();

  // The entry cannot be loaded (server error): saving is blocked, so an empty form cannot overwrite it.
  await page.route(`**/api/projects/${projectId}/reports/${pragueDay(-1)}`, (route) =>
    route.request().method() === "GET" ? route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"boom"}' }) : route.continue(),
  );
  await page.goto(`${projectUrl}/reports/${pragueDay(-1)}`);
  await expect(page.getByText(/nepodařilo načíst/i)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: /vytvořit záznam/i })).toBeDisabled();
});

test("two people editing the same entry: the second save is refused and offers the other version", async ({ browser, page, baseURL }) => {
  test.setTimeout(90_000);
  const projectUrl = await loginAndCreateProject(page);
  const day = pragueDay(0);
  const reportUrl = `${projectUrl}/reports/${day}`;
  const description = page.locator('textarea[name="workDescription"]');
  const save = (p: Page) => p.getByRole("button", { name: /vytvořit záznam/i });

  // Person A creates the entry.
  await page.goto(reportUrl);
  await expect(description).toBeVisible({ timeout: 15_000 });
  await description.fill("Verze osoby A");
  const created = page.waitForResponse((r) => r.request().method() === "POST" && r.url().includes(`/reports/${day}`));
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
  const changed = page.waitForResponse((r) => r.request().method() === "POST" && r.url().includes(`/reports/${day}`));
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

test("an entry for an earlier day is a flagged late entry with a reason; a future day cannot be saved", async ({ page }) => {
  test.setTimeout(90_000);
  const projectUrl = await loginAndCreateProject(page);
  const lateDay = pragueDay(-10);

  // The form asks for the reason; the entry is saved with it and shows up flagged.
  await page.goto(`${projectUrl}/reports/${lateDay}`);
  const reason = page.locator('textarea[name="lateEntryReason"]');
  await expect(reason).toBeVisible({ timeout: 15_000 });
  await page.locator('textarea[name="workDescription"]').fill("Zápis zpětně");
  await reason.fill("Deník byl na jiné stavbě");
  const saved = page.waitForResponse((r) => r.request().method() === "POST" && r.url().includes(`/reports/${lateDay}`));
  await page.getByRole("button", { name: /vytvořit záznam/i }).click();
  expect((await saved).ok()).toBeTruthy();

  await page.goto(`${projectUrl}/reports/${lateDay}`);
  await expect(page.getByText("Pozdní zápis", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/Důvod pozdního zápisu:/)).toBeVisible();
  await expect(page.getByText("Deník byl na jiné stavbě")).toBeVisible();
  await expect(page.locator('textarea[name="lateEntryReason"]')).toHaveCount(0);

  // An entry for today needs no reason.
  await page.goto(`${projectUrl}/reports/${pragueDay(0)}`);
  await expect(page.locator('textarea[name="workDescription"]')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('textarea[name="lateEntryReason"]')).toHaveCount(0);

  // A day that has not come yet cannot be saved.
  await page.goto(`${projectUrl}/reports/${pragueDay(1)}`);
  await expect(page.getByText(/budoucí datum/i)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: /vytvořit záznam/i })).toBeDisabled();
});

test("the weather is entered by hand, saved with the entry, shown again, and can be cleared", async ({ page }) => {
  test.setTimeout(90_000);
  const projectUrl = await loginAndCreateProject(page);
  const day = pragueDay(0);
  const save = () => page.getByRole("button", { name: /vytvořit záznam/i });
  const saved = () => page.waitForResponse((r) => r.request().method() === "POST" && r.url().includes(`/reports/${day}`));

  await page.goto(`${projectUrl}/reports/${day}`);
  await expect(page.locator('input[name="weatherCondition"]')).toHaveValue("", { timeout: 15_000 });
  await page.locator('textarea[name="workDescription"]').fill("Betonáž");
  await page.locator('input[name="weatherCondition"]').fill("zataženo");
  await page.locator('input[name="weatherMin"]').fill("8.5");
  await page.locator('input[name="weatherMax"]').fill("15");
  const first = saved();
  await save().click();
  expect((await first).ok()).toBeTruthy();

  // Back again: the weather is what was entered.
  await page.goto(`${projectUrl}/reports/${day}`);
  await expect(page.locator('input[name="weatherCondition"]')).toHaveValue("zataženo", { timeout: 15_000 });
  await expect(page.locator('input[name="weatherMin"]')).toHaveValue("8.5");
  await expect(page.locator('input[name="weatherMax"]')).toHaveValue("15");

  // Clearing the fields clears the weather.
  await page.locator('input[name="weatherCondition"]').fill("");
  await page.locator('input[name="weatherMin"]').fill("");
  await page.locator('input[name="weatherMax"]').fill("");
  const second = saved();
  await save().click();
  expect((await second).ok()).toBeTruthy();
  await page.goto(`${projectUrl}/reports/${day}`);
  await expect(page.locator('textarea[name="workDescription"]')).toHaveValue("Betonáž", { timeout: 15_000 });
  await expect(page.locator('input[name="weatherCondition"]')).toHaveValue("");
  await expect(page.locator('input[name="weatherMin"]')).toHaveValue("");
});

test("two people opening the same empty day: the second save is refused, the first entry survives", async ({ browser, page, baseURL }) => {
  test.setTimeout(90_000);
  const projectUrl = await loginAndCreateProject(page);
  const reportUrl = `${projectUrl}/reports/${pragueDay(0)}`;
  const save = (p: Page) => p.getByRole("button", { name: /vytvořit záznam/i });

  // Both open the day while it is empty.
  await page.goto(reportUrl);
  await expect(page.locator('textarea[name="workDescription"]')).toBeVisible({ timeout: 15_000 });
  const other = await browser.newContext({ baseURL });
  const pageB = await other.newPage();
  await login(pageB);
  await pageB.goto(reportUrl);
  await expect(pageB.locator('textarea[name="workDescription"]')).toBeVisible({ timeout: 15_000 });

  // A saves first.
  await page.locator('textarea[name="workDescription"]').fill("Zápis osoby A");
  const savedA = page.waitForResponse((r) => r.request().method() === "POST" && r.url().includes("/reports/"));
  await save(page).click();
  expect((await savedA).ok()).toBeTruthy();

  // B, who still sees an empty day, writes and saves: told, not silently replacing A.
  await pageB.locator('textarea[name="workDescription"]').fill("Zápis osoby B");
  await save(pageB).click();
  await expect(pageB.getByRole("alert")).toContainText(/mezitím někdo založil/i, { timeout: 15_000 });
  await pageB.getByRole("button", { name: /načíst aktuální verzi/i }).click();
  await expect(pageB.locator('textarea[name="workDescription"]')).toHaveValue("Zápis osoby A", { timeout: 15_000 });
  await other.close();
});

test("signing needs a saved entry, signs what was saved, and leaves a read-only form", async ({ page }) => {
  test.setTimeout(90_000);
  const projectUrl = await loginAndCreateProject(page);
  await page.goto(`${projectUrl}/reports/${pragueDay(0)}`);
  const description = page.locator('textarea[name="workDescription"]');
  const sign = page.getByRole("button", { name: /podepsat a uzamknout/i });
  await expect(description).toBeVisible({ timeout: 15_000 });

  // Nothing saved yet: nothing to sign.
  await expect(sign).toBeDisabled();

  await description.fill("První verze");
  const first = page.waitForResponse((r) => r.request().method() === "POST" && r.url().includes("/reports/"));
  await page.getByRole("button", { name: /vytvořit záznam/i }).click();
  expect((await first).ok()).toBeTruthy();
  await expect(sign).toBeEnabled();

  // Unsaved changes: signing is blocked, so a signature never covers words that were not saved.
  await description.fill("První verze, ale ještě neuloženo");
  await expect(page.getByText(/neuložené změny/i).first()).toBeVisible();
  await expect(sign).toBeDisabled();
  const second = page.waitForResponse((r) => r.request().method() === "POST" && r.url().includes("/reports/"));
  await page.getByRole("button", { name: /vytvořit záznam/i }).click();
  expect((await second).ok()).toBeTruthy();
  await expect(sign).toBeEnabled();

  // Sign: the page shows "Podepsáno", the form can no longer be edited and the save button is gone.
  await sign.click();
  const signDialog = page.getByRole("dialog", { name: /podepsat a uzamknout záznam/i });
  await signDialog.getByLabel("Heslo").fill(ADMIN_PASSWORD);
  const signed = page.waitForResponse((r) => r.request().method() === "POST" && r.url().includes("/sign"));
  await signDialog.getByRole("button", { name: "Podepsat", exact: true }).click();
  expect((await signed).ok()).toBeTruthy();
  await expect(page.getByText("Podepsáno", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(description).toBeDisabled();
  await expect(description).toHaveValue("První verze, ale ještě neuloženo");
  await expect(page.getByRole("button", { name: /vytvořit záznam/i })).toHaveCount(0);
});

test("worker rows keep every trade and a count of 0, and a trade without a count is not saved", async ({ page }) => {
  test.setTimeout(90_000);
  const projectUrl = await loginAndCreateProject(page);
  const day = pragueDay(0);
  await page.goto(`${projectUrl}/reports/${day}`);
  await expect(page.locator('textarea[name="workDescription"]')).toBeVisible({ timeout: 15_000 });
  const save = () => page.getByRole("button", { name: /vytvořit záznam/i });

  // A trade without a head count: refused in the form, nothing is sent.
  await page.locator('textarea[name="workDescription"]').fill("Práce");
  await page.locator('input[name="workerTrade"]').first().fill("Zedník");
  await save().click();
  await expect(page.getByText(/zadejte počet pracovníků/i)).toBeVisible();

  // Two trades, one with a count of 0: both come back after a reload.
  await page.locator('input[name="workerCount"]').first().fill("3");
  await page.getByRole("button", { name: /přidat profesi/i }).click();
  await page.locator('input[name="workerTrade"]').nth(1).fill("Tesař");
  await page.locator('input[name="workerCount"]').nth(1).fill("0");
  const saved = page.waitForResponse((r) => r.request().method() === "POST" && r.url().includes("/reports/"));
  await save().click();
  expect((await saved).ok()).toBeTruthy();

  await page.goto(`${projectUrl}/reports/${day}`);
  await expect(page.locator('input[name="workerTrade"]')).toHaveCount(2, { timeout: 15_000 });
  await expect(page.locator('input[name="workerTrade"]').nth(1)).toHaveValue("Tesař");
  await expect(page.locator('input[name="workerCount"]').nth(1)).toHaveValue("0");
});
