import { expect, test, type Page } from "@playwright/test";
import { ADMIN_NICKNAME, ADMIN_PASSWORD } from "./global-setup";

/**
 * Backlog B2, first half: the day in the URL, and leaving a page with unsaved changes (a link inside the application,
 * the browser's Back button, logging out). The draft kept on the device is in `report-draft.spec.ts`.
 */

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

/** Logs in as the admin and creates a project; returns its URL (`/projects/<id>`). */
async function loginAndCreateProject(page: Page): Promise<string> {
  await login(page);
  await page.goto("/projects/new");
  await page.locator('input[name="name"]').fill(`E2E Navigation ${Date.now()}`);
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

const description = (page: Page) => page.locator('textarea[name="workDescription"]');
const saveButton = (page: Page) => page.getByRole("button", { name: /uložit (záznam|změny)/i });
const leaveDialog = (page: Page) => page.getByRole("dialog", { name: /neuložené změny/i });
const logoutDialog = (page: Page) => page.getByRole("dialog", { name: /odhlásit se/i });
const backToList = (page: Page) => page.getByRole("link", { name: /zpět na seznam záznamů/i });

/**
 * Which entry of the history the browser is on: the number React Router writes into `history.state` (`idx`) for every entry it
 * makes. The URL cannot say it (the same day can be in the history twice); a step back or forward is counted in these entries.
 */
const historyIndex = (page: Page) => page.evaluate(() => (history.state as { idx?: number } | null)?.idx ?? null);

/**
 * A blocked step back is undone by the router with a second `history.go`, which the browser carries out later, on its own (the
 * router has to be told about it, too: `popstate`). A step the test takes before that has happened is counted from an entry the
 * router has not come back to yet, and is lost. So after a question has been answered "stay", wait until the browser is where it was.
 */
async function expectBackOnEntry(page: Page, entry: number | null) {
  await expect.poll(() => historyIndex(page)).toBe(entry);
}

async function opensDay(page: Page, url: string) {
  await page.goto(url);
  await expect(page.getByText(/načítám záznam/i)).toBeHidden({ timeout: 15_000 });
}

test("the text of one day is never carried over into another day", async ({ page }) => {
  test.setTimeout(90_000);
  const projectUrl = await loginAndCreateProject(page);
  const dayA = pragueDay(0);
  const dayB = pragueDay(-1);

  // The way through the application: the list, day A, the list again, day B. Browser history now holds all four.
  await page.goto(`${projectUrl}?tab=reports`);
  await page.getByRole("button", { name: /nový pro dnešek/i }).click();
  await expect(page).toHaveURL(new RegExp(`/reports/${dayA}$`));
  await expect(description(page)).toBeEditable({ timeout: 15_000 });
  await backToList(page).click();
  await page.locator("#new-report-date").fill(dayB);
  await page.getByRole("button", { name: /otevřít den/i }).click();
  await expect(page).toHaveURL(new RegExp(`/reports/${dayB}$`));

  // Day B is written and saved.
  await expect(description(page)).toBeEditable({ timeout: 15_000 });
  await description(page).fill("Zápis dne B, který nepatří na den A");
  const saved = page.waitForResponse((r) => r.request().method() === "POST" && r.url().includes(`/reports/${dayB}`));
  await saveButton(page).click();
  expect((await saved).ok()).toBeTruthy();

  // Two steps back in the history go straight from day B to day A (the same route, only the day in the URL changes).
  await page.evaluate(() => history.go(-2));
  await expect(page).toHaveURL(new RegExp(`/reports/${dayA}$`));
  await expect(page.getByText(/načítám záznam/i)).toBeHidden({ timeout: 15_000 });

  // Day A has no entry: its form is empty, an entry that does not exist yet, with nothing to save but what is typed there.
  await expect(description(page)).toHaveValue("");
  await expect(page.getByRole("button", { name: "Uložit záznam", exact: true })).toBeEnabled();
  await expect(page.getByText(/neuložené změny/i)).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

/** The way through the application as in the test above (the list, day A, the list again, day B), with text typed on day B and not saved. */
async function unsavedTextOnDayB(page: Page): Promise<{ dayA: string; dayB: string }> {
  const projectUrl = await loginAndCreateProject(page);
  const dayA = pragueDay(0);
  const dayB = pragueDay(-1);

  await page.goto(`${projectUrl}?tab=reports`);
  await page.getByRole("button", { name: /nový pro dnešek/i }).click();
  await expect(description(page)).toBeEditable({ timeout: 15_000 });
  await backToList(page).click();
  await page.locator("#new-report-date").fill(dayB);
  await page.getByRole("button", { name: /otevřít den/i }).click();
  await expect(description(page)).toBeEditable({ timeout: 15_000 });
  await description(page).fill("Rozepsaný den B");
  return { dayA, dayB };
}

test("unsaved text on day B is not carried to day A either: the person is asked first", async ({ page }) => {
  test.setTimeout(90_000);
  const { dayA, dayB } = await unsavedTextOnDayB(page);

  // Going back two steps would leave day B with unsaved text: the page asks, and the URL does not change.
  const dayBEntry = await historyIndex(page);
  await page.evaluate(() => history.go(-2));
  await expect(leaveDialog(page)).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/reports/${dayB}$`));
  await leaveDialog(page).getByRole("button", { name: "Zůstat", exact: true }).click();
  // The question is gone from the page (not only hidden: a closed <dialog> would not be found by its role either), and the browser
  // is back on day B's entry.
  await expect(page.locator("dialog")).toHaveCount(0);
  await expectBackOnEntry(page, dayBEntry);
  await expect(description(page)).toHaveValue("Rozepsaný den B");
  // Focus is where it was before the question: back in the text the person was typing.
  await expect(description(page)).toBeFocused();

  // Leaving anyway: day A is a fresh, empty form.
  await page.evaluate(() => history.go(-2));
  await expect(leaveDialog(page)).toBeVisible();
  await leaveDialog(page).getByRole("button", { name: "Odejít bez uložení", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/reports/${dayA}$`));
  await expect(page.getByText(/načítám záznam/i)).toBeHidden({ timeout: 15_000 });
  await expect(description(page)).toHaveValue("");
});

test("a second step back right after 'Zůstat' is asked about again, also when the page is slow to draw the first answer", async ({ page }) => {
  test.setTimeout(90_000);
  const { dayA, dayB } = await unsavedTextOnDayB(page);

  // A slow phone: the page draws what the router tells it (a React transition) a good while after it was told, and the next step
  // back can come sooner than that. (Chromium's DevTools protocol; this file does not run in the phone projects.)
  const slowDevice = await page.context().newCDPSession(page);
  await slowDevice.send("Emulation.setCPUThrottlingRate", { rate: 20 });

  const dayBEntry = await historyIndex(page);
  await page.evaluate(() => history.go(-2));
  await expect(leaveDialog(page)).toBeVisible();
  await expectBackOnEntry(page, dayBEntry);

  // "Zůstat" and the next step back arrive together (Back pressed twice, a link clicked twice). The question was answered and is asked
  // again before the page has drawn the answer: it has to be there, open, and not the closed dialog of the first question.
  await leaveDialog(page)
    .getByRole("button", { name: "Zůstat", exact: true })
    .evaluate((button: HTMLElement) => {
      button.click();
      history.go(-2);
    });
  await expect(leaveDialog(page)).toBeVisible();
  await expect(page.locator("dialog")).toHaveCount(1);
  await expect(page).toHaveURL(new RegExp(`/reports/${dayB}$`));
  await slowDevice.send("Emulation.setCPUThrottlingRate", { rate: 1 });

  // It is a real question: nothing was lost, and leaving goes on.
  await expect(description(page)).toHaveValue("Rozepsaný den B");
  await leaveDialog(page).getByRole("button", { name: "Odejít bez uložení", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/reports/${dayA}$`));
  await expect(page.getByText(/načítám záznam/i)).toBeHidden({ timeout: 15_000 });
  await expect(description(page)).toHaveValue("");
});

test("leaving the entry through a link with unsaved changes asks first; staying keeps the text, leaving goes on", async ({ page }) => {
  test.setTimeout(90_000);
  const projectUrl = await loginAndCreateProject(page);
  const day = pragueDay(0);

  await page.goto(`${projectUrl}?tab=reports`);
  await page.getByRole("button", { name: /nový pro dnešek/i }).click();
  await expect(page).toHaveURL(new RegExp(`/reports/${day}$`));
  await expect(description(page)).toBeEditable({ timeout: 15_000 });

  // Nothing typed yet: a link just works.
  await page.getByRole("link", { name: "Projekty", exact: true }).click();
  await expect(page).toHaveURL(/\/projects$/);
  await page.goBack();
  await expect(description(page)).toBeEditable({ timeout: 15_000 });

  await description(page).fill("Rozepsaný zápis");

  // A link inside the application: the page asks, the URL and the text stay, and the safe answer has the focus.
  await backToList(page).click();
  await expect(leaveDialog(page)).toBeVisible();
  await expect(leaveDialog(page).getByRole("button", { name: "Zůstat", exact: true })).toBeFocused();
  await expect(page).toHaveURL(new RegExp(`/reports/${day}$`));

  // Escape is "stay" too.
  await page.keyboard.press("Escape");
  await expect(leaveDialog(page)).toBeHidden();
  await expect(description(page)).toHaveValue("Rozepsaný zápis");
  // Focus returns to the link that was clicked, not to the page body.
  await expect(backToList(page)).toBeFocused();

  // The browser's Back button asks as well.
  await page.goBack();
  await expect(leaveDialog(page)).toBeVisible();
  await leaveDialog(page).getByRole("button", { name: "Zůstat", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/reports/${day}$`));
  await expect(description(page)).toHaveValue("Rozepsaný zápis");
  await expect(backToList(page)).toBeFocused();

  // The header's links ask as well; "Odejít" goes on.
  await page.getByRole("link", { name: "Projekty", exact: true }).click();
  await expect(leaveDialog(page)).toBeVisible();
  await leaveDialog(page).getByRole("button", { name: "Odejít bez uložení", exact: true }).click();
  await expect(page).toHaveURL(/\/projects$/);
  await expect(leaveDialog(page)).toBeHidden();
});

test("a saved entry is left without a question", async ({ page }) => {
  test.setTimeout(90_000);
  const projectUrl = await loginAndCreateProject(page);
  const day = pragueDay(0);

  await opensDay(page, `${projectUrl}/reports/${day}`);
  await description(page).fill("Uložený zápis");
  const saved = page.waitForResponse((r) => r.request().method() === "POST" && r.url().includes(`/reports/${day}`));
  await saveButton(page).click();
  expect((await saved).ok()).toBeTruthy();
  await expect(page.getByText(/uloženo \d{1,2}:\d{2}/i)).toBeVisible();

  await backToList(page).click();
  await expect(page).toHaveURL(/tab=reports/);
  await expect(leaveDialog(page)).toHaveCount(0);
});

test("logging out with unsaved changes asks first; logging out without them does not", async ({ page }) => {
  test.setTimeout(90_000);
  const projectUrl = await loginAndCreateProject(page);
  const day = pragueDay(0);
  const url = `${projectUrl}/reports/${day}`;

  await opensDay(page, url);
  await description(page).fill("Rozepsáno, než se odhlásím");

  // Asked: staying changes nothing.
  await page.getByRole("button", { name: "Odhlásit se", exact: true }).click();
  await expect(logoutDialog(page)).toBeVisible();
  await expect(logoutDialog(page).getByRole("button", { name: "Zůstat", exact: true })).toBeFocused();
  await logoutDialog(page).getByRole("button", { name: "Zůstat", exact: true }).click();
  await expect(logoutDialog(page)).toBeHidden();
  await expect(page).toHaveURL(new RegExp(`/reports/${day}$`));
  await expect(description(page)).toHaveValue("Rozepsáno, než se odhlásím");
  // Focus is back on the button that opened the question.
  await expect(page.getByRole("button", { name: "Odhlásit se", exact: true })).toBeFocused();

  // Confirmed: logged out.
  await page.getByRole("button", { name: "Odhlásit se", exact: true }).click();
  await logoutDialog(page)
    .getByRole("button", { name: /odhlásit a zahodit/i })
    .click();
  await expect(page).toHaveURL(/\/login/, { timeout: 15_000 });
  expect(await page.evaluate(() => localStorage.getItem("user"))).toBeNull();

  // Signing in again does not bring the unsaved text back.
  await login(page);
  await opensDay(page, url);
  await expect(description(page)).toHaveValue("");

  // With nothing unsaved there is no question.
  await page.getByRole("button", { name: "Odhlásit se", exact: true }).click();
  await expect(page).toHaveURL(/\/login/, { timeout: 15_000 });
  await expect(logoutDialog(page)).toHaveCount(0);
});

test("the form of the project's identification asks before it is left with unsaved changes", async ({ page }) => {
  test.setTimeout(90_000);
  const projectUrl = await loginAndCreateProject(page);
  await page.goto(`${projectUrl}/edit`);
  await expect(page.getByRole("heading", { name: /údaje o stavbě/i })).toBeVisible({ timeout: 15_000 });

  // No change, no question.
  await page.getByRole("link", { name: "Projekty", exact: true }).click();
  await expect(page).toHaveURL(/\/projects$/);
  await page.goBack();
  await expect(page.getByRole("heading", { name: /údaje o stavbě/i })).toBeVisible({ timeout: 15_000 });

  await page.locator('input[name="name"]').fill("Přejmenováno a neuloženo");
  await page.getByRole("link", { name: "Projekty", exact: true }).click();
  await expect(leaveDialog(page)).toBeVisible();
  // Nothing of this page is kept as a draft, and the dialog does not say so.
  await expect(leaveDialog(page)).toContainText(/ztratí/i);
  await leaveDialog(page).getByRole("button", { name: "Zůstat", exact: true }).click();
  await expect(page.locator('input[name="name"]')).toHaveValue("Přejmenováno a neuloženo");
});
