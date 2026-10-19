import { expect, test, type Page } from "@playwright/test";
import { ADMIN_NICKNAME, ADMIN_PASSWORD, INVESTOR_NICKNAME, INVESTOR_PASSWORD } from "./global-setup";

/**
 * Backlog B2: leaving the entry page, the day in the URL, and the draft kept on the device.
 * The draft lives in localStorage under `denik:draft:v1:<user>:<project>:<day>` (frontend/src/lib/draftStore.ts).
 */

/** The e2e-investor account seeded by scripts/dev/e2e-prepare.ts. */
const INVESTOR_UUID = "22222222-2222-2222-2222-222222222222";
const DRAFT_PREFIX = "denik:draft:v1:";

/** A date in Prague, [offsetDays] from today, as YYYY-MM-DD. */
function pragueDay(offsetDays: number): string {
  const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Prague" }).format(new Date());
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

async function login(page: Page, nickname = ADMIN_NICKNAME, password = ADMIN_PASSWORD) {
  await page.goto("/login");
  await page.locator('input[name="nickname"]').fill(nickname);
  await page.locator('input[name="password"]').fill(password);
  await page.locator('button[type="submit"]').click();
  await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 });
}

/** Logs in as the admin and creates a project; returns its URL (`/projects/<id>`). */
async function loginAndCreateProject(page: Page): Promise<string> {
  await login(page);
  await page.goto("/projects/new");
  await page.locator('input[name="name"]').fill(`E2E Draft ${Date.now()}`);
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
const draftBanner = (page: Page) => page.getByRole("region", { name: /rozepsaný záznam/i });
const leaveDialog = (page: Page) => page.getByRole("dialog", { name: /neuložené změny/i });
const logoutDialog = (page: Page) => page.getByRole("dialog", { name: /odhlásit se/i });
const backToList = (page: Page) => page.getByRole("link", { name: /zpět na seznam záznamů/i });

const draftKeys = (page: Page): Promise<string[]> => page.evaluate((prefix) => Object.keys(localStorage).filter((k) => k.startsWith(prefix)), DRAFT_PREFIX);

/** Waits until the form's text has been written to the device, then returns. */
async function expectDraftKept(page: Page) {
  await expect.poll(() => draftKeys(page).then((keys) => keys.length), { timeout: 10_000 }).toBeGreaterThan(0);
}

async function opensDay(page: Page, url: string) {
  await page.goto(url);
  await expect(page.getByText(/načítám záznam/i)).toBeHidden({ timeout: 15_000 });
}

/** Writes a draft the way the application would have, for a test that needs one the form never made. */
async function plantDraft(page: Page, draft: { userId: string; projectId: string; day: string; savedAt: Date; text: string }) {
  await page.evaluate(
    ({ prefix, d }) => {
      const key = `${prefix}${encodeURIComponent(d.userId)}:${encodeURIComponent(d.projectId)}:${encodeURIComponent(d.day)}`;
      localStorage.setItem(
        key,
        JSON.stringify({
          version: 1,
          userId: d.userId,
          projectId: d.projectId,
          day: d.day,
          baseUpdatedAt: null,
          savedAt: d.savedAt,
          values: {
            workDescription: d.text,
            workers: [{ trade: "", count: "", names: "" }],
            isControlDay: false,
            constructionObj: "",
            weatherCondition: "",
            weatherMin: "",
            weatherMax: "",
            lateEntryReason: "",
            details: {},
          },
        }),
      );
      return key;
    },
    { prefix: DRAFT_PREFIX, d: { ...draft, savedAt: draft.savedAt.toISOString() } },
  );
}

const sessionUserId = (page: Page): Promise<string> => page.evaluate(() => JSON.parse(localStorage.getItem("user") ?? "{}").id as string);
const projectIdOf = (projectUrl: string): string => projectUrl.split("/").pop()!;

test("text left in the form when the tab is lost comes back as a draft: Obnovit fills the form, saving clears the draft", async ({ page }) => {
  test.setTimeout(90_000);
  const projectUrl = await loginAndCreateProject(page);
  const day = pragueDay(0);
  const url = `${projectUrl}/reports/${day}`;

  await opensDay(page, url);
  await description(page).fill("Betonáž stropu, první polovina");
  await page.locator('input[name="workerTrade"]').first().fill("Betonář");
  await page.locator('input[name="workerCount"]').first().fill("3");
  await page.getByLabel("Jména pracovníků 1").fill("Ing. Jan Novák, Ph.D.; Petr Svoboda");
  await page.getByLabel("Použité stroje a mechanizace").fill("Čerpadlo");
  await expectDraftKept(page);

  // The tab dies (a phone that kills it while the camera is open): no "leave?" question, nothing saved.
  await page.close();
  const reopened = await page.context().newPage();
  await reopened.goto(url);

  // The day is offered the draft; until the person decides, the form is locked and shows the stored (empty) entry.
  await expect(draftBanner(reopened)).toBeVisible({ timeout: 15_000 });
  await expect(draftBanner(reopened)).toContainText(/koncept/i);
  await expect(description(reopened)).toHaveValue("");
  await expect(description(reopened)).toBeDisabled();
  await expect(saveButton(reopened)).toBeDisabled();

  await draftBanner(reopened).getByRole("button", { name: "Obnovit", exact: true }).click();
  await expect(draftBanner(reopened)).toHaveCount(0);
  await expect(description(reopened)).toHaveValue("Betonáž stropu, první polovina");
  await expect(description(reopened)).toBeEditable();
  await expect(reopened.locator('input[name="workerTrade"]').first()).toHaveValue("Betonář");
  await expect(reopened.locator('input[name="workerCount"]').first()).toHaveValue("3");
  await expect(reopened.getByLabel("Jména pracovníků 1")).toHaveValue("Ing. Jan Novák, Ph.D.; Petr Svoboda");
  await expect(reopened.getByLabel("Použité stroje a mechanizace")).toHaveValue("Čerpadlo");
  // Restored text is still unsaved text.
  await expect(reopened.getByText(/neuložené změny/i)).toBeVisible();

  const saved = reopened.waitForResponse((r) => r.request().method() === "POST" && r.url().includes(`/reports/${day}`));
  await saveButton(reopened).click();
  expect((await saved).ok()).toBeTruthy();

  // Saved: the draft is gone, and the stored entry is what the next visit shows.
  await expect.poll(() => draftKeys(reopened)).toEqual([]);
  await reopened.reload();
  await expect(description(reopened)).toHaveValue("Betonáž stropu, první polovina", { timeout: 15_000 });
  await expect(draftBanner(reopened)).toHaveCount(0);
});

test("Zahodit throws the draft away and shows the stored entry", async ({ page }) => {
  test.setTimeout(90_000);
  const projectUrl = await loginAndCreateProject(page);
  const day = pragueDay(0);
  const url = `${projectUrl}/reports/${day}`;

  await opensDay(page, url);
  await description(page).fill("Uložená verze");
  const saved = page.waitForResponse((r) => r.request().method() === "POST" && r.url().includes(`/reports/${day}`));
  await saveButton(page).click();
  expect((await saved).ok()).toBeTruthy();
  await expect.poll(() => draftKeys(page)).toEqual([]);

  await description(page).fill("Rozepsaná verze, která se nikdy neuloží");
  await expectDraftKept(page);
  await page.close();
  const reopened = await page.context().newPage();
  await reopened.goto(url);

  await expect(draftBanner(reopened)).toBeVisible({ timeout: 15_000 });
  await draftBanner(reopened).getByRole("button", { name: "Zahodit", exact: true }).click();
  await expect(draftBanner(reopened)).toHaveCount(0);
  await expect(description(reopened)).toHaveValue("Uložená verze");
  await expect(description(reopened)).toBeEditable();
  await expect(reopened.getByText(/neuložené změny/i)).toHaveCount(0);
  expect(await draftKeys(reopened)).toEqual([]);

  // Gone for good: the next visit offers nothing.
  await reopened.reload();
  await expect(description(reopened)).toHaveValue("Uložená verze", { timeout: 15_000 });
  await expect(draftBanner(reopened)).toHaveCount(0);
});

test("a draft identical to the stored entry is not offered (the save went through, only its answer was lost)", async ({ page }) => {
  test.setTimeout(90_000);
  const projectUrl = await loginAndCreateProject(page);
  const day = pragueDay(0);
  const url = `${projectUrl}/reports/${day}`;

  // The server stores the entry, but the answer never reaches the page (a connection that dropped).
  await page.route(`**/api/projects/${projectIdOf(projectUrl)}/reports/${day}`, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    // Sent from the test (no Origin header, which the dev proxy would turn into a cross-site request), the page never sees the answer.
    const stored = await page.request.post(route.request().url(), { data: route.request().postDataJSON() });
    expect(stored.ok()).toBeTruthy();
    await route.abort("failed");
  });
  await opensDay(page, url);
  await description(page).fill("Uloženo, ale stránka to neví");
  await saveButton(page).click();
  await expect(page.getByRole("alert")).toContainText(/nepodařilo uložit/i, { timeout: 15_000 });
  await expectDraftKept(page);

  await page.close();
  const reopened = await page.context().newPage();
  await reopened.goto(url);

  // The stored entry already says what the draft says: nothing to restore, and the draft is not kept.
  await expect(description(reopened)).toHaveValue("Uloženo, ale stránka to neví", { timeout: 15_000 });
  await expect(draftBanner(reopened)).toHaveCount(0);
  await expect.poll(() => draftKeys(reopened)).toEqual([]);
});

test("a draft says when the entry has been saved by somebody else since it was typed", async ({ browser, page, baseURL }) => {
  test.setTimeout(90_000);
  const projectUrl = await loginAndCreateProject(page);
  const day = pragueDay(0);
  const url = `${projectUrl}/reports/${day}`;

  await opensDay(page, url);
  await description(page).fill("Moje rozepsané");
  await expectDraftKept(page);
  await page.close();

  // Meanwhile somebody else creates the entry for that day.
  const other = await browser.newContext({ baseURL });
  const pageB = await other.newPage();
  await login(pageB);
  await opensDay(pageB, url);
  await description(pageB).fill("Cizí zápis");
  const saved = pageB.waitForResponse((r) => r.request().method() === "POST" && r.url().includes(`/reports/${day}`));
  await saveButton(pageB).click();
  expect((await saved).ok()).toBeTruthy();
  await other.close();

  const reopened = await page.context().newPage();
  await reopened.goto(url);
  await expect(draftBanner(reopened)).toBeVisible({ timeout: 15_000 });
  await expect(description(reopened)).toHaveValue("Cizí zápis");
  await expect(draftBanner(reopened)).toContainText(/změněn/i);
  await expect(draftBanner(reopened)).toContainText(/přepíšete/i);
});

test("when the application starts, drafts older than 30 days and drafts of other people are removed", async ({ page }) => {
  test.setTimeout(90_000);
  const projectUrl = await loginAndCreateProject(page);
  const projectId = projectIdOf(projectUrl);
  const me = await sessionUserId(page);
  const days = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

  await plantDraft(page, { userId: me, projectId, day: pragueDay(-40), savedAt: days(31), text: "starý koncept" });
  await plantDraft(page, { userId: me, projectId, day: pragueDay(-3), savedAt: days(2), text: "čerstvý koncept" });
  await plantDraft(page, { userId: "someone-else", projectId, day: pragueDay(-3), savedAt: days(1), text: "koncept někoho jiného" });
  expect(await draftKeys(page)).toHaveLength(3);

  // The application prunes before it renders anything, so the load itself is enough to wait for.
  await page.reload();

  const kept = await draftKeys(page);
  expect(kept).toHaveLength(1);
  expect(kept[0]).toContain(`${encodeURIComponent(me)}:`);
  expect(kept[0]).toContain(pragueDay(-3));
});

test("somebody else signing in on the device does not inherit, and removes, the drafts of the person before", async ({ page }) => {
  test.setTimeout(90_000);
  const projectUrl = await loginAndCreateProject(page);
  const projectId = projectIdOf(projectUrl);
  const me = await sessionUserId(page);
  await plantDraft(page, { userId: me, projectId, day: pragueDay(0), savedAt: new Date(), text: "koncept stavbyvedoucího" });
  expect(await draftKeys(page)).toHaveLength(1);

  // The session ends without a logout (the cookie is gone); the investor signs in on the same device.
  await page.context().clearCookies();
  await login(page, INVESTOR_NICKNAME, INVESTOR_PASSWORD);

  expect(await draftKeys(page)).toEqual([]);
});

test("a signed entry never keeps a draft", async ({ page }) => {
  test.setTimeout(90_000);
  const projectUrl = await loginAndCreateProject(page);
  const day = pragueDay(0);
  const url = `${projectUrl}/reports/${day}`;

  await opensDay(page, url);
  await description(page).fill("Podepsaný zápis");
  const saved = page.waitForResponse((r) => r.request().method() === "POST" && r.url().includes(`/reports/${day}`));
  await saveButton(page).click();
  expect((await saved).ok()).toBeTruthy();
  await page.getByRole("button", { name: /podepsat a uzamknout/i }).click();
  const signDialog = page.getByRole("dialog", { name: /podepsat a uzamknout záznam/i });
  await signDialog.getByLabel("Heslo").fill(ADMIN_PASSWORD);
  await signDialog.getByRole("button", { name: "Podepsat", exact: true }).click();
  await expect(page.getByText("Podepsáno", { exact: true })).toBeVisible({ timeout: 15_000 });

  // A draft of that day (from before it was signed, or a damaged one) is not offered and is removed.
  await plantDraft(page, { userId: await sessionUserId(page), projectId: projectIdOf(projectUrl), day, savedAt: new Date(), text: "koncept podepsaného dne" });
  expect(await draftKeys(page)).toHaveLength(1);
  await page.reload();
  await expect(page.getByText("Podepsáno", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(draftBanner(page)).toHaveCount(0);
  await expect.poll(() => draftKeys(page)).toEqual([]);
  await expect(description(page)).toHaveValue("Podepsaný zápis");
});

test("somebody who may not write in the project never keeps a draft", async ({ browser, page, baseURL }) => {
  test.setTimeout(90_000);
  const projectUrl = await loginAndCreateProject(page);
  const projectId = projectIdOf(projectUrl);
  const day = pragueDay(0);

  // The investor is a member with a read-only role.
  const added = await page.request.post(`/api/projects/${projectId}/members`, { data: { userId: INVESTOR_UUID, role: "INVESTOR" } });
  expect(added.ok()).toBeTruthy();

  const other = await browser.newContext({ baseURL });
  const investor = await other.newPage();
  await login(investor, INVESTOR_NICKNAME, INVESTOR_PASSWORD);
  await plantDraft(investor, { userId: await sessionUserId(investor), projectId, day, savedAt: new Date(), text: "koncept bez práva zapisovat" });
  expect(await draftKeys(investor)).toHaveLength(1);

  await investor.goto(`${projectUrl}/reports/${day}`);
  await expect(investor.getByText(/můžete jen číst/i)).toBeVisible({ timeout: 15_000 });
  await expect(draftBanner(investor)).toHaveCount(0);
  await expect.poll(() => draftKeys(investor)).toEqual([]);
  await other.close();
});

test("the page works when the browser will not store the draft, and says the text would be lost", async ({ page }) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  // Storage that refuses everything about drafts (a full disk, a private window): every call throws.
  await page.addInitScript((prefix) => {
    for (const method of ["getItem", "setItem", "removeItem"] as const) {
      const original = Storage.prototype[method];
      Storage.prototype[method] = function (this: Storage, key: string, value?: string) {
        if (typeof key === "string" && key.startsWith(prefix)) throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
        return (original as (k: string, v?: string) => unknown).call(this, key, value);
      } as never;
    }
  }, DRAFT_PREFIX);

  const projectUrl = await loginAndCreateProject(page);
  const day = pragueDay(0);
  await opensDay(page, `${projectUrl}/reports/${day}`);
  await expect(description(page)).toBeEditable();
  await description(page).fill("Text bez uložení konceptu");
  await expect(page.getByText(/neuložené změny/i)).toBeVisible();

  // The page does not pretend: nothing is kept, so leaving loses the text.
  await backToList(page).click();
  await expect(leaveDialog(page)).toBeVisible();
  await expect(leaveDialog(page)).toContainText(/ztratí/i);
  await expect(leaveDialog(page)).not.toContainText(/koncept/i);
  await leaveDialog(page).getByRole("button", { name: "Zůstat", exact: true }).click();

  // Saving still works.
  const saved = page.waitForResponse((r) => r.request().method() === "POST" && r.url().includes(`/reports/${day}`));
  await saveButton(page).click();
  expect((await saved).ok()).toBeTruthy();
  await expect(page.getByText(/uloženo \d{1,2}:\d{2}/i)).toBeVisible();
  expect(errors).toEqual([]);
});

test("leaving a page with unsaved text says the text stays as a draft, and the day offers it again", async ({ page }) => {
  test.setTimeout(90_000);
  const projectUrl = await loginAndCreateProject(page);
  const day = pragueDay(0);
  const url = `${projectUrl}/reports/${day}`;

  await page.goto(`${projectUrl}?tab=reports`);
  await page.getByRole("button", { name: /nový pro dnešek/i }).click();
  await expect(page).toHaveURL(new RegExp(`/reports/${day}$`));
  await expect(description(page)).toBeEditable({ timeout: 15_000 });
  await description(page).fill("Rozepsaný zápis, který zůstane jako koncept");

  // The question says what happens to the text: it is kept on this device, and offered when the day is opened again.
  await backToList(page).click();
  await expect(leaveDialog(page)).toBeVisible();
  await expect(leaveDialog(page)).toContainText(/koncept/i);
  await expect(leaveDialog(page)).not.toContainText(/ztratí/i);
  await leaveDialog(page).getByRole("button", { name: "Odejít bez uložení", exact: true }).click();
  await expect(page).toHaveURL(/tab=reports/);

  await page.goto(url);
  await expect(draftBanner(page)).toBeVisible({ timeout: 15_000 });
  await draftBanner(page).getByRole("button", { name: "Obnovit", exact: true }).click();
  await expect(description(page)).toHaveValue("Rozepsaný zápis, který zůstane jako koncept");
});

test("a draft is only offered on its own day", async ({ page }) => {
  test.setTimeout(90_000);
  const projectUrl = await loginAndCreateProject(page);
  const dayA = pragueDay(0);
  const dayB = pragueDay(-1);

  await opensDay(page, `${projectUrl}/reports/${dayB}`);
  await description(page).fill("Rozepsaný den B");
  await expectDraftKept(page);

  // Another day of the same project has none, and the draft of day B is still there for day B.
  await page.close();
  const reopened = await page.context().newPage();
  await reopened.goto(`${projectUrl}/reports/${dayA}`);
  await expect(reopened.getByText(/načítám záznam/i)).toBeHidden({ timeout: 15_000 });
  await expect(description(reopened)).toHaveValue("");
  await expect(draftBanner(reopened)).toHaveCount(0);
  expect(await draftKeys(reopened)).toHaveLength(1);

  await reopened.goto(`${projectUrl}/reports/${dayB}`);
  await expect(draftBanner(reopened)).toBeVisible({ timeout: 15_000 });
});

test("logging out removes the draft, and signing in again does not bring it back", async ({ page }) => {
  test.setTimeout(90_000);
  const projectUrl = await loginAndCreateProject(page);
  const day = pragueDay(0);
  const url = `${projectUrl}/reports/${day}`;

  await opensDay(page, url);
  await description(page).fill("Rozepsáno, než se odhlásím");
  await expectDraftKept(page);

  // The question says what is thrown away; staying changes nothing.
  await page.getByRole("button", { name: "Odhlásit se", exact: true }).click();
  await expect(logoutDialog(page)).toContainText(/koncept/i);
  await logoutDialog(page).getByRole("button", { name: "Zůstat", exact: true }).click();
  expect((await draftKeys(page)).length).toBeGreaterThan(0);

  // Confirmed: logged out, and nothing of the entry stays on the device.
  await page.getByRole("button", { name: "Odhlásit se", exact: true }).click();
  await logoutDialog(page)
    .getByRole("button", { name: /odhlásit a zahodit/i })
    .click();
  await expect(page).toHaveURL(/\/login/, { timeout: 15_000 });
  expect(await draftKeys(page)).toEqual([]);

  await login(page);
  await opensDay(page, url);
  await expect(description(page)).toHaveValue("");
  await expect(draftBanner(page)).toHaveCount(0);
});

/** Lets the page render and run what the render started (two animation frames), so "nothing was written" is a statement about a settled page. */
const settled = (page: Page) => page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

test("a failed request for the role keeps the draft, and the draft is offered once the role has loaded", async ({ page }) => {
  test.setTimeout(90_000);
  const projectUrl = await loginAndCreateProject(page);
  const projectId = projectIdOf(projectUrl);
  const day = pragueDay(0);
  const url = `${projectUrl}/reports/${day}`;

  await opensDay(page, url);
  await description(page).fill("Rozepsáno, než spadlo spojení");
  await expectDraftKept(page);
  const context = page.context();
  await page.close();

  // The entry loads, but the request for the person's role in the project fails (a bad connection).
  const reopened = await context.newPage();
  let roleFails = true;
  await reopened.route(`**/api/projects/${projectId}`, (route) =>
    roleFails && route.request().method() === "GET" ? route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"boom"}' }) : route.continue(),
  );
  const entryAnswered = reopened.waitForResponse((r) => r.url().includes(`/reports/${day}`) && r.request().method() === "GET");
  const roleAnswered = reopened.waitForResponse((r) => r.url().endsWith(`/api/projects/${projectId}`));
  await reopened.goto(url);
  await Promise.all([entryAnswered, roleAnswered]);
  await settled(reopened);

  // Nothing was decided without the role: the draft is still on the device, the form is locked, and the page says what is wrong
  // instead of claiming the entry can only be read.
  expect(await draftKeys(reopened)).toHaveLength(1);
  await expect(reopened.getByRole("alert").filter({ hasText: /roli/i })).toBeVisible({ timeout: 15_000 });
  await expect(reopened.getByText(/můžete jen číst/i)).toHaveCount(0);
  await expect(description(reopened)).toBeHidden();
  await expect(draftBanner(reopened)).toHaveCount(0);

  // The role loads on a retry: now the draft is offered, and it is the text that was typed.
  roleFails = false;
  await reopened.getByRole("button", { name: "Zkusit znovu", exact: true }).click();
  await expect(draftBanner(reopened)).toBeVisible({ timeout: 15_000 });
  await draftBanner(reopened).getByRole("button", { name: "Obnovit", exact: true }).click();
  await expect(description(reopened)).toHaveValue("Rozepsáno, než spadlo spojení");
});

test("another tab cannot make this tab write one person's text under another person's draft", async ({ page }) => {
  test.setTimeout(90_000);
  const projectUrl = await loginAndCreateProject(page);
  const day = pragueDay(0);

  await opensDay(page, `${projectUrl}/reports/${day}`);
  await description(page).fill("Text osoby A, jména: Ing. Jan Novák");
  await expectDraftKept(page);

  // In a second tab of the same browser A logs out and the investor signs in; the first tab still holds A's unsaved text.
  const second = await page.context().newPage();
  await second.goto("/projects");
  await second.getByRole("button", { name: "Odhlásit se", exact: true }).click();
  await expect(second).toHaveURL(/\/login/, { timeout: 15_000 });
  await login(second, INVESTOR_NICKNAME, INVESTOR_PASSWORD);
  expect(await draftKeys(second)).toEqual([]);

  // The first tab goes on typing: nothing is written, least of all under the investor's key.
  await description(page).pressSequentially(" a další věta");
  await settled(page);
  expect(await draftKeys(second)).toEqual([]);
});

test("visiting the login page does not wipe the drafts, and the same person finds theirs after signing in", async ({ page }) => {
  test.setTimeout(90_000);
  const projectUrl = await loginAndCreateProject(page);
  const day = pragueDay(0);
  const url = `${projectUrl}/reports/${day}`;

  await opensDay(page, url);
  await description(page).fill("Rozepsáno, než jsem otevřel přihlašovací stránku");
  await expectDraftKept(page);
  const context = page.context();
  await page.close();

  // The login page forgets who was signed in; the application then starts again with nobody signed in.
  const reopened = await context.newPage();
  await reopened.goto("/login");
  expect(await reopened.evaluate(() => localStorage.getItem("user"))).toBeNull();
  await reopened.goto("/login");
  expect(await draftKeys(reopened)).toHaveLength(1);

  // The same person signs in: the draft is theirs and is offered.
  await login(reopened);
  expect(await draftKeys(reopened)).toHaveLength(1);
  await reopened.goto(url);
  await expect(draftBanner(reopened)).toBeVisible({ timeout: 15_000 });
});

test("a draft that differs from the stored entry only by what the server tidies up is not offered", async ({ page }) => {
  test.setTimeout(90_000);
  const projectUrl = await loginAndCreateProject(page);
  const day = pragueDay(0);
  const url = `${projectUrl}/reports/${day}`;

  // The server stores the entry, but the answer never reaches the page (a connection that dropped).
  await page.route(`**/api/projects/${projectIdOf(projectUrl)}/reports/${day}`, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const stored = await page.request.post(route.request().url(), { data: route.request().postDataJSON() });
    expect(stored.ok()).toBeTruthy();
    await route.abort("failed");
  });
  await opensDay(page, url);
  await description(page).fill("Betonáž");
  // A trailing space after the trade, names without a space after the semicolon, an empty second trade row, a temperature written as 8.50.
  await page.locator('input[name="workerTrade"]').first().fill("Zedník ");
  await page.locator('input[name="workerCount"]').first().fill("3");
  await page.getByLabel("Jména pracovníků 1").fill("Jan;Petr");
  await page.getByRole("button", { name: /přidat profesi/i }).click();
  await page.locator('input[name="weatherMin"]').fill("8.50");
  await saveButton(page).click();
  await expect(page.getByRole("alert")).toContainText(/nepodařilo uložit/i, { timeout: 15_000 });
  await expectDraftKept(page);
  const context = page.context();
  await page.close();

  const reopened = await context.newPage();
  await reopened.goto(url);

  // The stored entry says what the draft says, in the server's form: no banner, no false "changed by somebody else".
  await expect(reopened.getByLabel("Jména pracovníků 1")).toHaveValue("Jan; Petr", { timeout: 15_000 });
  await expect(draftBanner(reopened)).toHaveCount(0);
  await expect.poll(() => draftKeys(reopened)).toEqual([]);
});

test("an entry cannot be signed while a draft waits for the person's answer", async ({ page }) => {
  test.setTimeout(90_000);
  const projectUrl = await loginAndCreateProject(page);
  const day = pragueDay(0);
  const url = `${projectUrl}/reports/${day}`;
  const sign = (p: Page) => p.getByRole("button", { name: /podepsat a uzamknout/i });

  await opensDay(page, url);
  await description(page).fill("Uložená verze");
  const saved = page.waitForResponse((r) => r.request().method() === "POST" && r.url().includes(`/reports/${day}`));
  await saveButton(page).click();
  expect((await saved).ok()).toBeTruthy();
  await expect(sign(page)).toBeEnabled();
  await description(page).fill("Rozepsaná verze, která se nesmí dostat do podpisu");
  await expectDraftKept(page);
  const context = page.context();
  await page.close();

  const reopened = await context.newPage();
  await reopened.goto(url);
  await expect(draftBanner(reopened)).toBeVisible({ timeout: 15_000 });

  // The stored entry is unsaved-free and could be signed, but not before the person has answered the offer: otherwise "Obnovit"
  // would put unsigned text into a form that says "Podepsáno".
  await expect(sign(reopened)).toBeDisabled();
  await draftBanner(reopened).getByRole("button", { name: "Zahodit", exact: true }).click();
  await expect(sign(reopened)).toBeEnabled();
});
