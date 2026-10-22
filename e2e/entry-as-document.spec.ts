import { expect, test, type APIRequestContext, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { ADMIN_NICKNAME, ADMIN_PASSWORD, INVESTOR_NICKNAME, INVESTOR_PASSWORD } from "./global-setup";

/**
 * The entry as a document, and the lists (backlog B4): a signed entry, and every entry seen by somebody who cannot write it, is a
 * document with the signer on it, not a disabled form; the lists say the number, the day with its weekday, the author and the state;
 * the list of projects says what state today's entry is in. One state vocabulary everywhere (Rozpracováno, Podepsáno), and exactly one
 * element on the entry page that says "Podepsáno" (the other specs match it exactly).
 *
 * The data is made through the API (a project of its own for every test, named for the run), so each test reads what it made.
 */

const INVESTOR_ID = "22222222-2222-2222-2222-222222222222";
const WORKER_ID = "55555555-5555-5555-5555-555555555555";
const WORKER_NICKNAME = "worker@stavebni-denik.cz";
const WORKER_NAME = "Worker Stavební Deník";
const ADMIN_NAME = "E2E Admin";

/** A date in Prague, [offsetDays] from today, as YYYY-MM-DD. */
function pragueDay(offsetDays: number): string {
  const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Prague" }).format(new Date());
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

/** A Monday of the past, so the weekday printed on the page is known whatever day the suite runs. */
const A_MONDAY = "2026-09-28";
const A_MONDAY_CZ = "po 28. 9. 2026";

const SIGNED_AT = /\d{1,2}\. \d{1,2}\. \d{4} \d{2}:\d{2}:\d{2} (SEČ|SELČ) \(UTC\+[12]\)/;

async function signIn(page: Page, nickname = ADMIN_NICKNAME, password = ADMIN_PASSWORD) {
  await page.goto("/login");
  await page.locator('input[name="nickname"]').fill(nickname);
  await page.locator('input[name="password"]').fill(password);
  await page.locator('button[type="submit"]').click();
  await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 });
}

async function post<T = unknown>(api: APIRequestContext, path: string, body: unknown): Promise<T> {
  const res = await api.post(path, { data: body });
  expect(res.ok(), `POST ${path}: ${res.status()} ${await res.text()}`).toBeTruthy();
  return (await res.json()) as T;
}

/** A body for an entry with a bit of everything; [extra] overrides. */
const entryBody = (date: string, extra: Record<string, unknown> = {}) => ({
  date,
  workDescription: "Betonáž stropní desky nad prvním podlažím.\nDruhý řádek popisu.",
  workersByTrade: JSON.stringify([
    { trade: "Zedník", count: 4, names: ["Jan Novák", "Petr Svoboda"] },
    { trade: "Železář", count: 3 },
  ]),
  details: { materials: "Beton C25/30 XC1, 24 m3", safetyNotes: "Poučení pracovníků proběhlo v 7:00" },
  weather: { condition: "zataženo", tempMin: 8.5, tempMax: 15 },
  isControlDay: true,
  constructionObj: "SO-101",
  lateEntryReason: "Doplněno dodatečně.",
  expectNew: true,
  ...extra,
});

interface Site {
  /** The administrator, signed in; their context makes the data. */
  page: Page;
  api: APIRequestContext;
  context: BrowserContext;
  projectId: string;
  projectName: string;
}

/** A project of its own, with the investor and the worker as members, and the administrator as its site manager. */
async function newSite(browser: Browser, baseURL: string | undefined, extra: Record<string, unknown> = {}): Promise<Site> {
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  await signIn(page);
  const admin = JSON.parse((await page.evaluate(() => localStorage.getItem("user"))) ?? "null") as { id: string };
  const projectName = `Dokument ${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const project = await post<{ id: string }>(context.request, "/api/projects", {
    name: projectName,
    address: "Kotlářská 12, Brno",
    cadastralArea: "Veveří",
    parcelNumbers: "450/1",
    builder: "Statutární město Brno",
    contractor: "Stavby Morava a.s.",
    siteManagerId: admin.id,
    ...extra,
  });
  await post(context.request, `/api/projects/${project.id}/members`, { userId: INVESTOR_ID, role: "INVESTOR" });
  await post(context.request, `/api/projects/${project.id}/members`, { userId: WORKER_ID, role: "WORKER" });
  return { page, api: context.request, context, projectId: project.id, projectName };
}

/** An entry made and (when [sign]) signed by the administrator; returns it. */
async function makeEntry(site: Site, date: string, extra: Record<string, unknown> = {}, sign = false) {
  const saved = await post<{ id: string; updatedAt: string }>(site.api, `/api/projects/${site.projectId}/reports/${date}`, entryBody(date, extra));
  if (sign) await post(site.api, `/api/projects/${site.projectId}/reports/${date}/sign`, { password: ADMIN_PASSWORD, expectedUpdatedAt: saved.updatedAt });
  return saved;
}

/** A second person, signed in in a context of their own. */
async function personPage(browser: Browser, baseURL: string | undefined, nickname: string, password: string): Promise<{ page: Page; context: BrowserContext }> {
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  await signIn(page, nickname, password);
  return { page, context };
}

const podepsano = (page: Page) => page.getByText("Podepsáno", { exact: true });

/** The editable fields of the form of an entry (not the addenda or the entries of other parties, which are forms of their own). */
const entryFields = (page: Page) => page.locator('textarea[name="workDescription"], textarea[name^="detail-"], input[name="workerTrade"], input[name="constructionObj"]');

test.describe("a signed entry is a document", () => {
  test("the signer, the number and the time are on the page without a click, and what is empty is named in one line", async ({ browser, baseURL }) => {
    test.setTimeout(90_000);
    const site = await newSite(browser, baseURL);
    try {
      await makeEntry(site, A_MONDAY, {}, true);
      const page = site.page;
      await page.goto(`/projects/${site.projectId}/reports/${A_MONDAY}`);

      // The head: the project, the day with its weekday, the number and the state, and the marks.
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(`Denní záznam stavby: pondělí 28. 9. 2026`, { timeout: 15_000 });
      await expect(page.getByText(site.projectName, { exact: true })).toBeVisible();
      await expect(page.getByText("Záznam č. 1", { exact: true })).toBeVisible();
      await expect(podepsano(page)).toHaveCount(1);
      await expect(page.getByText("Pozdní zápis", { exact: true })).toBeVisible();
      await expect(page.getByText("Kontrolní den")).toBeVisible();
      await expect(page.getByText("SO: SO-101")).toBeVisible();
      await expect(page.getByText(`Autor: ${ADMIN_NAME}`)).toBeVisible();

      // The signature card: who, with the ČKAIT number, and when, without the button being pressed.
      const card = page.getByRole("region", { name: "Podpis záznamu" });
      await expect(card).toBeVisible();
      await expect(card.getByText(`${ADMIN_NAME}, ČKAIT 0000000`)).toBeVisible();
      await expect(card.getByText(SIGNED_AT)).toBeVisible();
      await expect(card.getByText(/Otisk obsahu \(SHA-256\)/)).toBeVisible();
      await expect(card.getByText(/podepsán a uzamčen/)).toBeVisible();

      // The content as text: in full, nothing to type into, no example text that reads like content.
      await expect(page.getByRole("heading", { level: 2, name: "Popis prací" })).toBeVisible();
      await expect(page.getByText("Betonáž stropní desky nad prvním podlažím.")).toBeVisible();
      await expect(page.getByText("Druhý řádek popisu.")).toBeVisible();
      await expect(page.getByText("zataženo, 8,5 až 15 °C")).toBeVisible();
      await expect(page.getByText("Beton C25/30 XC1, 24 m3")).toBeVisible();
      await expect(page.getByText("Poučení pracovníků proběhlo v 7:00")).toBeVisible();
      const workers = page.getByRole("table");
      await expect(workers.getByRole("row", { name: /Zedník 4 Jan Novák; Petr Svoboda/ })).toBeVisible();
      await expect(workers.getByRole("row", { name: /Železář 3/ })).toBeVisible();
      await expect(page.getByText("Celkem pracovníků: 7")).toBeVisible();

      // What says nothing is named once, not shown as seven empty boxes: the filled fields are not in that line, the empty ones are.
      const none = page.getByText(/^Bez záznamu: /);
      await expect(none).toHaveCount(1);
      // set apart from the text above it, in the muted small type of a note (a class that is not applied would leave it glued to it)
      await expect(none).toHaveCSS("margin-top", "16px");
      await expect(none).toHaveCSS("font-size", "14px");
      await expect(none).toContainText("Použité stroje a mechanizace");
      await expect(none).toContainText("Zahájení, přerušení a obnovení prací");
      await expect(none).not.toContainText("Dodávky a uskladnění materiálu");
      await expect(none).not.toContainText("Bezpečnost práce");
      await expect(page.getByText("Použité stroje a mechanizace", { exact: true })).toHaveCount(0);

      // It is not a form: no fields, no way to add a trade, no example text, no way to add a photo.
      await expect(entryFields(page)).toHaveCount(0);
      await expect(page.getByRole("button", { name: /přidat profesi/i })).toHaveCount(0);
      await expect(page.getByText(/např\. Zedník/)).toHaveCount(0);
      await expect(page.locator('input[type="file"]')).toHaveCount(0);
      await expect(page.getByRole("button", { name: /uložit (záznam|změny)/i })).toHaveCount(0);
      await expect(page.getByRole("button", { name: /podepsat a uzamknout/i })).toHaveCount(0);
      await expect(page.getByText("Bez fotografií.")).toBeVisible();

      // "Ověřit podpis" is still there, and still verifies.
      await card.getByRole("button", { name: "Ověřit podpis" }).click();
      await expect(page.getByRole("status")).toContainText(/Obsah odpovídá podpisu/, { timeout: 15_000 });
    } finally {
      await site.context.close();
    }
  });

  test("an entry signed by somebody else than its author shows both, and the signer is not the author", async ({ browser, baseURL }) => {
    test.setTimeout(90_000);
    const site = await newSite(browser, baseURL);
    const worker = await personPage(browser, baseURL, WORKER_NICKNAME, ADMIN_PASSWORD);
    try {
      // The worker writes the entry; the manager signs it.
      await post(worker.context.request, `/api/projects/${site.projectId}/reports/${A_MONDAY}`, entryBody(A_MONDAY, { isControlDay: false }));
      await post(site.api, `/api/projects/${site.projectId}/reports/${A_MONDAY}/sign`, { password: ADMIN_PASSWORD });

      await site.page.goto(`/projects/${site.projectId}/reports/${A_MONDAY}`);
      await expect(site.page.getByText(`Autor: ${WORKER_NAME}`)).toBeVisible({ timeout: 15_000 });
      await expect(site.page.getByRole("region", { name: "Podpis záznamu" }).getByText(`${ADMIN_NAME}, ČKAIT 0000000`)).toBeVisible();
      await expect(podepsano(site.page)).toHaveCount(1);
    } finally {
      await worker.context.close();
      await site.context.close();
    }
  });
});

/** The levels of the headings of the page, in the order of the page. */
const headingLevels = (page: Page): Promise<number[]> =>
  page.locator("main").evaluate((main) => Array.from(main.querySelectorAll("h1, h2, h3, h4, h5, h6")).map((h) => Number(h.tagName.slice(1))));

/** An outline a screen reader can use: one h1 first, and no level skipped on the way down. */
function expectOutline(levels: number[], what: string) {
  expect(levels[0], `${what}: the first heading is the h1`).toBe(1);
  expect(
    levels.filter((l) => l === 1),
    `${what}: one h1`,
  ).toHaveLength(1);
  levels.forEach((level, i) => {
    if (i > 0) expect(level, `${what}: heading ${i + 1} of ${levels.join(",")} does not skip a level`).toBeLessThanOrEqual(levels[i - 1] + 1);
  });
}

test.describe("the headings", () => {
  test("a signed entry, the form of a draft and a day nobody wrote have an outline of headings, one h1 and no skipped level", async ({ browser, baseURL }) => {
    test.setTimeout(90_000);
    const site = await newSite(browser, baseURL);
    const investor = await personPage(browser, baseURL, INVESTOR_NICKNAME, INVESTOR_PASSWORD);
    try {
      await makeEntry(site, A_MONDAY, {}, true);
      await makeEntry(site, "2026-09-29", {}, false);
      const page = site.page;

      await page.goto(`/projects/${site.projectId}/reports/${A_MONDAY}`);
      await expect(page.getByRole("region", { name: "Podpis záznamu" })).toBeVisible({ timeout: 15_000 });
      // the parts of the document are headings: the description, the trades, the weather, the other fields, the photos, the signature
      for (const name of ["Popis prací", "Pracovníci podle profesí", "Počasí", "Další zápisy", "Fotodokumentace", "Podpis záznamu"]) {
        await expect(page.getByRole("heading", { level: 2, name })).toBeVisible();
      }
      expectOutline(await headingLevels(page), "a signed entry");

      await page.goto(`/projects/${site.projectId}/reports/2026-09-29`);
      await expect(page.locator('textarea[name="workDescription"]')).toBeEditable({ timeout: 15_000 });
      expectOutline(await headingLevels(page), "the form of a draft");

      await investor.page.goto(`/projects/${site.projectId}/reports/${pragueDay(-1)}`);
      await expect(investor.page.getByText("Za tento den zatím není žádný záznam.")).toBeVisible({ timeout: 15_000 });
      expectOutline(await headingLevels(investor.page), "a day nobody wrote");
    } finally {
      await investor.context.close();
      await site.context.close();
    }
  });
});

test.describe("somebody who cannot write sees a document", () => {
  test("an investor reads a signed entry as a document, with the signer, and can acknowledge it", async ({ browser, baseURL }) => {
    test.setTimeout(90_000);
    const site = await newSite(browser, baseURL);
    const investor = await personPage(browser, baseURL, INVESTOR_NICKNAME, INVESTOR_PASSWORD);
    try {
      await makeEntry(site, A_MONDAY, {}, true);
      const page = investor.page;
      await page.goto(`/projects/${site.projectId}/reports/${A_MONDAY}`);

      await expect(page.getByRole("heading", { level: 1 })).toContainText("pondělí 28. 9. 2026", { timeout: 15_000 });
      await expect(podepsano(page)).toHaveCount(1);
      await expect(page.getByRole("region", { name: "Podpis záznamu" }).getByText(`${ADMIN_NAME}, ČKAIT 0000000`)).toBeVisible();
      await expect(page.getByText("Betonáž stropní desky nad prvním podlažím.")).toBeVisible();
      await expect(entryFields(page)).toHaveCount(0);
      await expect(page.locator('input[type="file"]')).toHaveCount(0);
      await expect(page.getByRole("button", { name: /uložit (záznam|změny)/i })).toHaveCount(0);

      page.once("dialog", (d) => d.accept());
      await page.getByRole("button", { name: "Potvrdit seznámení" }).click();
      await expect(page.getByText(/Seznámil\(a\) se: E2E Investor \(stavebník\)/)).toBeVisible({ timeout: 15_000 });
      await expect(podepsano(page)).toHaveCount(1);
    } finally {
      await investor.context.close();
      await site.context.close();
    }
  });

  test("an entry being written is a document for the investor too: in progress, without a number, and read only", async ({ browser, baseURL }) => {
    test.setTimeout(90_000);
    const site = await newSite(browser, baseURL);
    const investor = await personPage(browser, baseURL, INVESTOR_NICKNAME, INVESTOR_PASSWORD);
    try {
      await makeEntry(site, A_MONDAY, {}, false);
      const page = investor.page;
      await page.goto(`/projects/${site.projectId}/reports/${A_MONDAY}`);

      await expect(page.getByText("Rozpracováno", { exact: true })).toBeVisible({ timeout: 15_000 });
      await expect(podepsano(page)).toHaveCount(0);
      await expect(page.getByText("bez čísla", { exact: true })).toBeVisible();
      await expect(page.getByText(/Záznam č\. \d/)).toHaveCount(0);
      await expect(page.getByText("Betonáž stropní desky nad prvním podlažím.")).toBeVisible();
      await expect(page.getByText(/můžete jen číst/i)).toBeVisible();
      await expect(entryFields(page)).toHaveCount(0);
      await expect(page.getByRole("region", { name: "Podpis záznamu" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Potvrdit seznámení" })).toHaveCount(0);
    } finally {
      await investor.context.close();
      await site.context.close();
    }
  });

  test("a day nobody has written says so to somebody who cannot write it, instead of offering an empty form", async ({ browser, baseURL }) => {
    test.setTimeout(90_000);
    const site = await newSite(browser, baseURL);
    const investor = await personPage(browser, baseURL, INVESTOR_NICKNAME, INVESTOR_PASSWORD);
    try {
      const page = investor.page;
      await page.goto(`/projects/${site.projectId}/reports/${pragueDay(-1)}`);

      await expect(page.getByText("Za tento den zatím není žádný záznam.")).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText(/můžete jen číst/i)).toBeVisible();
      await expect(entryFields(page)).toHaveCount(0);
      await expect(page.getByRole("button", { name: /uložit (záznam|změny)/i })).toHaveCount(0);
      await expect(page.getByRole("heading", { level: 1 })).toContainText("Denní záznam stavby");
    } finally {
      await investor.context.close();
      await site.context.close();
    }
  });
});

test.describe("while an entry is written, every field prompts", () => {
  test("the manager editing a draft sees all nine fields of the vyhláška, and a day that has no entry yet says so in its state", async ({ browser, baseURL }) => {
    test.setTimeout(90_000);
    const site = await newSite(browser, baseURL);
    try {
      await makeEntry(site, A_MONDAY, {}, false);
      const page = site.page;
      await page.goto(`/projects/${site.projectId}/reports/${A_MONDAY}`);

      await expect(page.locator('textarea[name="workDescription"]')).toBeEditable({ timeout: 15_000 });
      await expect(page.locator('textarea[name^="detail-"]')).toHaveCount(9);
      // The empty ones are there to be filled in, with their prompt.
      await expect(page.locator('textarea[name="detail-machinery"]')).toHaveAttribute("placeholder", /Stroje a mechanizace/);
      await expect(page.getByText("Rozpracováno", { exact: true })).toBeVisible();
      await expect(podepsano(page)).toHaveCount(0);
      await expect(page.getByText(/^Bez záznamu: /)).toHaveCount(0);

      // A day nobody has written: not "Rozpracováno", and no number.
      await page.goto(`/projects/${site.projectId}/reports/${pragueDay(0)}`);
      await expect(page.locator('textarea[name="workDescription"]')).toBeEditable({ timeout: 15_000 });
      await expect(page.getByText("Nezapsáno", { exact: true })).toBeVisible();
      await expect(page.getByText("Rozpracováno", { exact: true })).toHaveCount(0);
      await expect(page.getByText("bez čísla", { exact: true })).toBeVisible();
    } finally {
      await site.context.close();
    }
  });

  test("signing in the page turns the form into the document, with the signer, at once", async ({ browser, baseURL }) => {
    test.setTimeout(90_000);
    const site = await newSite(browser, baseURL);
    try {
      await makeEntry(site, A_MONDAY, {}, false);
      const page = site.page;
      await page.goto(`/projects/${site.projectId}/reports/${A_MONDAY}`);
      await expect(page.locator('textarea[name="workDescription"]')).toBeEditable({ timeout: 15_000 });
      await expect(podepsano(page)).toHaveCount(0);

      await page.getByRole("button", { name: /podepsat a uzamknout/i }).click();
      const dialog = page.getByRole("dialog", { name: /podepsat a uzamknout záznam/i });
      await dialog.getByLabel("Heslo").fill(ADMIN_PASSWORD);
      await dialog.getByRole("button", { name: "Podepsat", exact: true }).click();

      await expect(podepsano(page)).toHaveCount(1, { timeout: 15_000 });
      await expect(page.getByText("Záznam č. 1", { exact: true })).toBeVisible();
      await expect(page.getByRole("region", { name: "Podpis záznamu" }).getByText(`${ADMIN_NAME}, ČKAIT 0000000`)).toBeVisible();
      await expect(entryFields(page)).toHaveCount(0);
    } finally {
      await site.context.close();
    }
  });
});

test.describe("the list of entries", () => {
  test("a row says the number, the day with its weekday, the author and the state, and the whole row is one link", async ({ browser, baseURL }) => {
    test.setTimeout(120_000);
    const site = await newSite(browser, baseURL);
    const worker = await personPage(browser, baseURL, WORKER_NICKNAME, ADMIN_PASSWORD);
    try {
      // A signed late control day (the manager's), a draft of the worker's, and today's draft (not late).
      await makeEntry(site, A_MONDAY, {}, true);
      await post(
        worker.context.request,
        `/api/projects/${site.projectId}/reports/2026-09-29`,
        entryBody("2026-09-29", { isControlDay: false, workDescription: "Práce na střeše" }),
      );
      await post(
        site.api,
        `/api/projects/${site.projectId}/reports/${pragueDay(0)}`,
        entryBody(pragueDay(0), { isControlDay: false, lateEntryReason: undefined, workDescription: "Dnešní práce" }),
      );

      const page = site.page;
      await page.goto(`/projects/${site.projectId}?tab=reports`);
      const rows = page.getByRole("listitem").filter({ has: page.getByRole("link", { name: /Záznam č\.|bez čísla/ }) });
      await expect(rows).toHaveCount(3, { timeout: 15_000 });

      // The signed one: the number, the Czech day with its weekday, the author, the state and the marks.
      const signed = rows.filter({ hasText: A_MONDAY_CZ });
      await expect(signed.getByRole("link", { name: `${A_MONDAY_CZ} · Záznam č. 1` })).toBeVisible();
      await expect(signed.getByText(`Autor: ${ADMIN_NAME}`)).toBeVisible();
      await expect(signed.getByText("Podepsáno", { exact: true })).toBeVisible();
      await expect(signed.getByText("Pozdní zápis", { exact: true })).toBeVisible();
      await expect(signed.getByText("Kontrolní den", { exact: true })).toBeVisible();
      await expect(signed).not.toContainText("2026-09-28");

      // The worker's draft: no number yet, in progress, by the worker.
      const draft = rows.filter({ hasText: "út 29. 9. 2026" });
      await expect(draft.getByRole("link", { name: "út 29. 9. 2026 · bez čísla" })).toBeVisible();
      await expect(draft.getByText(`Autor: ${WORKER_NAME}`)).toBeVisible();
      await expect(draft.getByText("Rozpracováno", { exact: true })).toBeVisible();
      await expect(draft.getByText("Podepsáno", { exact: true })).toHaveCount(0);
      await expect(draft.getByText("Kontrolní den")).toHaveCount(0);

      // One name for the link of a row (not the whole sentence of the row), and the PDF is a button of its own.
      await expect(signed.getByRole("link")).toHaveCount(1);
      await expect(signed.getByRole("button", { name: "Stáhnout PDF záznamu z 28. 9. 2026" })).toBeVisible();

      // The whole row is the link: a click on its text, away from the link's own words, opens the entry.
      // (forced: Playwright would refuse the click because the link covers the text, which is the point; the click itself is a real one.)
      await signed.getByText(`Autor: ${ADMIN_NAME}`).click({ force: true });
      await expect(page).toHaveURL(new RegExp(`/projects/${site.projectId}/reports/${A_MONDAY}$`));
      await expect(podepsano(page)).toHaveCount(1, { timeout: 15_000 });
    } finally {
      await worker.context.close();
      await site.context.close();
    }
  });

  test("the PDF button of a row downloads that entry and does not open it", async ({ browser, baseURL }) => {
    test.setTimeout(90_000);
    const site = await newSite(browser, baseURL);
    try {
      await makeEntry(site, A_MONDAY, {}, true);
      const page = site.page;
      await page.goto(`/projects/${site.projectId}?tab=reports`);
      const pdf = page.getByRole("button", { name: "Stáhnout PDF záznamu z 28. 9. 2026" });
      await expect(pdf).toBeVisible({ timeout: 15_000 });
      const listUrl = page.url();
      const requested = page.waitForResponse((r) => r.url().includes("/pdf"));
      await pdf.click();
      await requested;
      expect(page.url(), "the PDF button is above the link of the row").toBe(listUrl);
    } finally {
      await site.context.close();
    }
  });
});

test.describe("the list of projects", () => {
  test("says what state today's entry is in, and links to the day", async ({ browser, baseURL }) => {
    test.setTimeout(90_000);
    const site = await newSite(browser, baseURL);
    try {
      const page = site.page;
      const card = () => page.getByRole("listitem").filter({ hasText: site.projectName });
      const today = pragueDay(0);

      await page.goto("/projects");
      await expect(card()).toBeVisible({ timeout: 15_000 });
      await expect(card().getByRole("link", { name: "Dnes: nezapsáno" })).toBeVisible();

      // A draft for today.
      await makeEntry(site, today, { lateEntryReason: undefined, isControlDay: false }, false);
      await page.goto("/projects");
      await expect(card().getByRole("link", { name: "Dnes: rozpracováno" })).toBeVisible({ timeout: 15_000 });
      await expect(card().getByRole("link", { name: "Dnes: rozpracováno" })).toHaveAttribute("href", `/projects/${site.projectId}/reports/${today}`);

      // Signed.
      await post(site.api, `/api/projects/${site.projectId}/reports/${today}/sign`, { password: ADMIN_PASSWORD });
      await page.goto("/projects");
      const signedLink = card().getByRole("link", { name: "Dnes: podepsáno" });
      await expect(signedLink).toBeVisible({ timeout: 15_000 });

      // The link opens that day (not the project), and the card as a whole still opens the project.
      await signedLink.click();
      await expect(page).toHaveURL(new RegExp(`/projects/${site.projectId}/reports/${today}$`));
      await expect(podepsano(page)).toHaveCount(1, { timeout: 15_000 });
      await page.goto("/projects");
      await card().getByRole("link", { name: site.projectName }).click();
      await expect(page).toHaveURL(new RegExp(`/projects/${site.projectId}$`));
    } finally {
      await site.context.close();
    }
  });

  test("an investor sees the state of today, and a day nobody wrote is only words, with nothing to open", async ({ browser, baseURL }) => {
    test.setTimeout(90_000);
    const site = await newSite(browser, baseURL);
    const investor = await personPage(browser, baseURL, INVESTOR_NICKNAME, INVESTOR_PASSWORD);
    try {
      const page = investor.page;
      await page.goto("/projects");
      const card = page.getByRole("listitem").filter({ hasText: site.projectName });
      await expect(card.getByText("Dnes: nezapsáno")).toBeVisible({ timeout: 15_000 });
      await expect(card.getByRole("link", { name: "Dnes: nezapsáno" })).toHaveCount(0);

      await makeEntry(site, pragueDay(0), { lateEntryReason: undefined, isControlDay: false }, true);
      await page.goto("/projects");
      await expect(card.getByRole("link", { name: "Dnes: podepsáno" })).toBeVisible({ timeout: 15_000 });
    } finally {
      await investor.context.close();
      await site.context.close();
    }
  });

  test("with no project there is an empty state, with a way to add one for those who may", async ({ browser, baseURL }) => {
    const none = (route: { fulfill: (o: { json: unknown }) => Promise<void> }) => route.fulfill({ json: [] });

    // A project manager (who is not an administrator) may create a project: the empty state says so and offers it.
    const manager = await personPage(browser, baseURL, "manager@stavebni-denik.cz", ADMIN_PASSWORD);
    try {
      const page = manager.page;
      await page.route("**/api/projects", none);
      await page.goto("/projects");
      await expect(page.getByText(/Zatím nemáte žádný projekt/)).toBeVisible({ timeout: 15_000 });
      await expect(page.getByRole("link", { name: "Přidat projekt" })).toHaveCount(1);
      await page.getByRole("link", { name: "Přidat projekt" }).click();
      await expect(page).toHaveURL(/\/projects\/new$/);
    } finally {
      await manager.context.close();
    }

    // An administrator sees every project, so an empty list means that none exists; one who is a manager too may create the first.
    const boss = await browser.newContext({ baseURL });
    try {
      const page = await boss.newPage();
      await signIn(page);
      await page.route("**/api/projects", none);
      await page.goto("/projects");
      await expect(page.getByText(/Zatím nejsou založeny žádné stavby\. Založte první/)).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText(/Zatím nemáte žádný projekt/)).toHaveCount(0);
      await expect(page.getByRole("link", { name: "Přidat projekt" })).toHaveCount(1);
    } finally {
      await boss.close();
    }

    // Somebody who may not create one is told whom to ask, and is not offered what would be refused.
    const investor = await personPage(browser, baseURL, INVESTOR_NICKNAME, INVESTOR_PASSWORD);
    try {
      await investor.page.route("**/api/projects", none);
      await investor.page.goto("/projects");
      await expect(investor.page.getByText(/Zatím nejste členem žádného projektu/)).toBeVisible({ timeout: 15_000 });
      await expect(investor.page.getByRole("link", { name: "Přidat projekt" })).toHaveCount(0);
    } finally {
      await investor.context.close();
    }
  });
});

test.describe("the project header", () => {
  /** Elements of [scope] that take room, have a border or a background of their own and hold no text: a box with nothing in it. */
  async function emptyBoxes(scope: Locator): Promise<string[]> {
    return scope.evaluate((root) =>
      Array.from(root.querySelectorAll<HTMLElement>("div, dl, section, p, ul, span"))
        .filter((el) => {
          if (el.textContent?.trim() !== "" || el.querySelector("img, svg, input, button, select, textarea")) return false;
          const r = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          const hasBorder = ["Top", "Right", "Bottom", "Left"].some((side) => parseFloat(style.getPropertyValue(`border-${side.toLowerCase()}-width`)) > 0);
          const hasBackground = style.backgroundColor !== "rgba(0, 0, 0, 0)" && style.backgroundColor !== "transparent";
          return r.width > 0 && r.height > 0 && (hasBorder || hasBackground);
        })
        .map((el) => `${el.tagName.toLowerCase()}.${String(el.className).split(/\s+/).slice(0, 3).join(".")}`),
    );
  }

  test("a project without a contract number and a documentation version has no box for them, and one that has shows them", async ({ browser, baseURL }) => {
    test.setTimeout(90_000);
    const bare = await newSite(browser, baseURL);
    const full = await newSite(browser, baseURL, { contractNumber: "SML-2026/17", designDocVersion: "v1.2" });
    try {
      const header = (page: Page) => page.getByRole("heading", { level: 1 }).locator("xpath=ancestor::div[contains(@class,'rounded-lg')][1]");

      await bare.page.goto(`/projects/${bare.projectId}`);
      await expect(bare.page.getByRole("heading", { level: 1, name: bare.projectName })).toBeVisible({ timeout: 15_000 });
      await expect(bare.page.getByText("Číslo smlouvy")).toHaveCount(0);
      await expect(bare.page.getByText("Dokumentace:")).toHaveCount(0);
      expect(await emptyBoxes(header(bare.page))).toEqual([]);

      await full.page.goto(`/projects/${full.projectId}`);
      await expect(full.page.getByRole("heading", { level: 1, name: full.projectName })).toBeVisible({ timeout: 15_000 });
      await expect(full.page.getByText("Číslo smlouvy:")).toBeVisible();
      await expect(full.page.getByText("SML-2026/17")).toBeVisible();
      await expect(full.page.getByText("v1.2", { exact: true })).toBeVisible();
      expect(await emptyBoxes(header(full.page))).toEqual([]);
    } finally {
      await bare.context.close();
      await full.context.close();
    }
  });
});

test.describe("signing in the page", () => {
  const signDialog = (page: Page) => page.getByRole("dialog", { name: /podepsat a uzamknout záznam/i });
  /**
   * Whether the focus is on an element of the page behind the dialog. Inside the dialog it is not; and when it leaves the page for the
   * browser's own controls (what Tab does at the end of a modal dialog) nothing of the page has it either (the `body`).
   */
  const focusIsOnThePageBehind = (page: Page) =>
    page.evaluate(() => {
      const active = document.activeElement;
      return Boolean(active && active !== document.body && !active.closest('dialog, [role="dialog"]'));
    });

  test("the dialog holds the focus: nothing can be typed behind it, and a signed entry never asks about text that is not there", async ({ browser, baseURL }) => {
    test.setTimeout(90_000);
    const site = await newSite(browser, baseURL);
    try {
      await makeEntry(site, A_MONDAY, {}, false);
      const page = site.page;
      await page.goto(`/projects/${site.projectId}/reports/${A_MONDAY}`);
      const description = page.locator('textarea[name="workDescription"]');
      await expect(description).toBeEditable({ timeout: 15_000 });
      const written = await description.inputValue();

      await page.getByRole("button", { name: /podepsat a uzamknout/i }).click();
      const dialog = signDialog(page);
      await dialog.getByLabel("Heslo").fill(ADMIN_PASSWORD);

      // Tab and Shift+Tab never reach the form behind the dialog.
      for (let i = 0; i < 6; i++) {
        await page.keyboard.press("Shift+Tab");
        expect(await focusIsOnThePageBehind(page), `Shift+Tab, press ${i + 1}`).toBe(false);
      }
      for (let i = 0; i < 6; i++) {
        await page.keyboard.press("Tab");
        expect(await focusIsOnThePageBehind(page), `Tab, press ${i + 1}`).toBe(false);
      }
      // What is typed while the dialog is open lands nowhere in the form behind it.
      await page.keyboard.type("psáno za dialogem");
      await expect(description).toHaveValue(written);
      await expect(page.getByText("Neuložené změny")).toHaveCount(0);

      // Signing: the entry is a document, and the page has nothing unsaved (the browser would ask on closing the tab; the application on a link).
      await dialog.getByLabel("Heslo").fill(ADMIN_PASSWORD);
      await dialog.getByRole("button", { name: "Podepsat", exact: true }).click();
      await expect(podepsano(page)).toHaveCount(1, { timeout: 15_000 });
      expect(
        await page.evaluate(() => {
          const event = new Event("beforeunload", { cancelable: true });
          window.dispatchEvent(event);
          return event.defaultPrevented;
        }),
        "the browser is not told to ask before the page is closed",
      ).toBe(false);
      await page.getByRole("link", { name: /zpět na seznam záznamů/i }).click();
      await expect(page).toHaveURL(/tab=reports/);
      await expect(page.getByRole("dialog", { name: /neuložené změny/i })).toHaveCount(0);
    } finally {
      await site.context.close();
    }
  });

  test("Escape and Zrušit close the dialog and keep the form as it was", async ({ browser, baseURL }) => {
    test.setTimeout(90_000);
    const site = await newSite(browser, baseURL);
    try {
      await makeEntry(site, A_MONDAY, {}, false);
      const page = site.page;
      await page.goto(`/projects/${site.projectId}/reports/${A_MONDAY}`);
      await expect(page.locator('textarea[name="workDescription"]')).toBeEditable({ timeout: 15_000 });

      await page.getByRole("button", { name: /podepsat a uzamknout/i }).click();
      await expect(signDialog(page)).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(signDialog(page)).toHaveCount(0);

      await page.getByRole("button", { name: /podepsat a uzamknout/i }).click();
      await signDialog(page).getByRole("button", { name: "Zrušit" }).click();
      await expect(signDialog(page)).toHaveCount(0);
      await expect(podepsano(page)).toHaveCount(0);
      await expect(page.locator('textarea[name="workDescription"]')).toBeEditable();
    } finally {
      await site.context.close();
    }
  });

  test("when what the server says of the signature cannot be loaded, the card says so and can try again", async ({ browser, baseURL }) => {
    test.setTimeout(90_000);
    const site = await newSite(browser, baseURL);
    try {
      await makeEntry(site, A_MONDAY, {}, false);
      const page = site.page;
      let failing = false;
      // The reads of the entry fail while [failing] (the signing itself is another URL and is not touched).
      await page.route(`**/api/projects/${site.projectId}/reports/${A_MONDAY}`, (route) =>
        failing && route.request().method() === "GET" ? route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"boom"}' }) : route.continue(),
      );
      await page.goto(`/projects/${site.projectId}/reports/${A_MONDAY}`);
      await expect(page.locator('textarea[name="workDescription"]')).toBeEditable({ timeout: 15_000 });

      failing = true;
      await page.getByRole("button", { name: /podepsat a uzamknout/i }).click();
      await signDialog(page).getByLabel("Heslo").fill(ADMIN_PASSWORD);
      await signDialog(page).getByRole("button", { name: "Podepsat", exact: true }).click();

      // The entry is signed (the head says so, and the form is gone), but the card does not pretend to know more than it does.
      await expect(podepsano(page)).toHaveCount(1, { timeout: 15_000 });
      const card = page.getByRole("region", { name: "Podpis záznamu" });
      await expect(card.getByText("Údaje o podpisu se nepodařilo načíst.")).toBeVisible();
      await expect(card.getByText("Načítám údaje o podpisu…")).toHaveCount(0);
      await expect(card.getByRole("button", { name: "Zkusit znovu" })).toBeVisible();
      // A signed entry is not "bez čísla": the number is not known yet, which is something else.
      await expect(page.getByText("bez čísla", { exact: true })).toHaveCount(0);
      await expect(entryFields(page)).toHaveCount(0);

      failing = false;
      await card.getByRole("button", { name: "Zkusit znovu" }).click();
      await expect(card.getByText(`${ADMIN_NAME}, ČKAIT 0000000`)).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText("Záznam č. 1", { exact: true })).toBeVisible();
      await expect(card.getByText("Údaje o podpisu se nepodařilo načíst.")).toHaveCount(0);
      await expect(podepsano(page)).toHaveCount(1);
    } finally {
      await site.context.close();
    }
  });
});

test.describe("who may change an entry is decided by the server", () => {
  const REASON = "Záznam může upravit jen jeho autor nebo stavbyvedoucí.";

  test("a worker gets the document, with the reason, for an entry of the manager, and the form for their own", async ({ browser, baseURL }) => {
    test.setTimeout(90_000);
    const site = await newSite(browser, baseURL);
    const worker = await personPage(browser, baseURL, WORKER_NICKNAME, ADMIN_PASSWORD);
    try {
      // The manager's entry, and the worker's own.
      await makeEntry(site, A_MONDAY, {}, false);
      await post(worker.context.request, `/api/projects/${site.projectId}/reports/2026-09-29`, entryBody("2026-09-29", { workDescription: "Práce zedníků" }));
      const page = worker.page;

      await page.goto(`/projects/${site.projectId}/reports/${A_MONDAY}`);
      await expect(page.getByText("Betonáž stropní desky nad prvním podlažím.")).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText(REASON)).toBeVisible();
      await expect(page.getByText(/můžete jen číst/i)).toHaveCount(0);
      await expect(entryFields(page)).toHaveCount(0);
      await expect(page.getByRole("button", { name: /uložit (záznam|změny)/i })).toHaveCount(0);
      await expect(page.getByText("Rozpracováno", { exact: true })).toBeVisible();
      // What a worker may do to the manager's entry is still allowed: add a photo.
      await expect(page.locator('input[type="file"]')).toBeVisible();

      // Their own: the form, and a save that goes through.
      await page.goto(`/projects/${site.projectId}/reports/2026-09-29`);
      const description = page.locator('textarea[name="workDescription"]');
      await expect(description).toBeEditable({ timeout: 15_000 });
      await expect(page.getByText(REASON)).toHaveCount(0);
      await description.fill("Práce zedníků, doplněno");
      const saved = page.waitForResponse((r) => r.request().method() === "POST" && r.url().includes("/reports/2026-09-29"));
      await page.getByRole("button", { name: /uložit (záznam|změny)/i }).click();
      expect((await saved).ok()).toBeTruthy();

      // A day nobody wrote: a worker may write it.
      await page.goto(`/projects/${site.projectId}/reports/${pragueDay(0)}`);
      await expect(page.locator('textarea[name="workDescription"]')).toBeEditable({ timeout: 15_000 });
    } finally {
      await worker.context.close();
      await site.context.close();
    }
  });

  test("the manager keeps the form for the worker's entry, and the investor still reads only", async ({ browser, baseURL }) => {
    test.setTimeout(90_000);
    const site = await newSite(browser, baseURL);
    const worker = await personPage(browser, baseURL, WORKER_NICKNAME, ADMIN_PASSWORD);
    const investor = await personPage(browser, baseURL, INVESTOR_NICKNAME, INVESTOR_PASSWORD);
    try {
      await post(worker.context.request, `/api/projects/${site.projectId}/reports/${A_MONDAY}`, entryBody(A_MONDAY, { workDescription: "Práce zedníků" }));

      await site.page.goto(`/projects/${site.projectId}/reports/${A_MONDAY}`);
      await expect(site.page.locator('textarea[name="workDescription"]')).toBeEditable({ timeout: 15_000 });
      await expect(site.page.getByText(REASON)).toHaveCount(0);

      await investor.page.goto(`/projects/${site.projectId}/reports/${A_MONDAY}`);
      await expect(investor.page.getByText(/můžete jen číst/i)).toBeVisible({ timeout: 15_000 });
      await expect(investor.page.getByText(REASON)).toHaveCount(0);
    } finally {
      await investor.context.close();
      await worker.context.close();
      await site.context.close();
    }
  });
});

test.describe("a signature that lacks its signer", () => {
  test("the card says the data is incomplete, and a whole one says nothing of the kind", async ({ browser, baseURL }) => {
    test.setTimeout(90_000);
    const site = await newSite(browser, baseURL);
    try {
      await makeEntry(site, A_MONDAY, {}, true);
      const page = site.page;
      const card = page.getByRole("region", { name: "Podpis záznamu" });
      const WARNING = "Údaje o podepisujícím jsou neúplné; ověřte podpis.";

      await page.goto(`/projects/${site.projectId}/reports/${A_MONDAY}`);
      await expect(card.getByText(`${ADMIN_NAME}, ČKAIT 0000000`)).toBeVisible({ timeout: 15_000 });
      await expect(card.getByText(WARNING)).toHaveCount(0);

      // What the server says of a row that lost the number of its signer (only a row changed behind the application is like that).
      await page.route(`**/api/projects/${site.projectId}/reports/${A_MONDAY}`, async (route) => {
        const response = await route.fetch();
        const body = await response.json();
        await route.fulfill({ response, json: { ...body, signerCkaitNumber: null, signerIncomplete: true } });
      });
      await page.reload();
      await expect(card.getByText(WARNING)).toBeVisible({ timeout: 15_000 });
      await expect(card.getByText(ADMIN_NAME)).toBeVisible();
      await expect(card.getByRole("button", { name: "Ověřit podpis" })).toBeVisible();
      await expect(podepsano(page)).toHaveCount(1);
    } finally {
      await site.context.close();
    }
  });
});

test.describe("the empty list of projects, for an administrator", () => {
  test("an administrator who may not create a project sees every project, so an empty list means there are none", async ({ browser, baseURL }) => {
    const context = await browser.newContext({ baseURL });
    try {
      const page = await context.newPage();
      await signIn(page);
      // The account as the application keeps it on the device: an administrator whose own role is not BOSS (the server decides in the end).
      await page.evaluate(() => {
        const user = JSON.parse(localStorage.getItem("user") ?? "{}");
        localStorage.setItem("user", JSON.stringify({ ...user, role: "WORKER", isAdmin: true }));
      });
      await page.route("**/api/projects", (route) => route.fulfill({ json: [] }));
      await page.goto("/projects");
      await expect(page.getByText("Zatím nejsou založeny žádné stavby.")).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText(/Zatím nejste členem/)).toHaveCount(0);
      await expect(page.getByRole("link", { name: "Přidat projekt" })).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
});
