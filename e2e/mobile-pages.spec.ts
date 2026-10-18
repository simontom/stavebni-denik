import { expect, request as playwrightRequest, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { ADMIN_NICKNAME, ADMIN_PASSWORD, INVESTOR_NICKNAME, INVESTOR_PASSWORD } from "./global-setup";

/**
 * The phone project (360 x 780, touch; `playwright.config.ts`): every main page is visited with realistic data (long names,
 * many rows, an entry full of text, a signed entry) and must
 *  - not scroll sideways (the browser would otherwise shrink the whole page to fit, or hide what is off the screen),
 *  - keep the primary controls (logout, the way into the pages) on the screen and large enough for a thumb (44 px),
 *  - have inputs of 16 px or more (iOS zooms the page into a smaller field when it is focused).
 * The data is made through the API once, so the pages are what a real project looks like, not the empty one.
 */

const BASE_URL = process.env.BASE_URL ?? "http://localhost:5173";
const MIN_TARGET = 44;

/** A date in Prague, [offsetDays] from today, as YYYY-MM-DD. */
function pragueDay(offsetDays: number): string {
  const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Prague" }).format(new Date());
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

// One name per run (the local database keeps the projects of earlier runs), long enough to wrap on a phone.
const LONG_NAME = `Rekonstrukce bytového domu Na Příkopě 123/45 včetně nástavby podkroví a revitalizace vnitrobloku (${Date.now().toString(36)})`;
const LONG_ADDRESS = "Na Příkopě 123/45, Praha 1 - Nové Město, 110 00, areál bývalé továrny u Vltavy";
const PARCELS = Array.from({ length: 30 }, (_, i) => `450/${i + 1}`).join(", ");
/** One long word without a place to break: the usual way a phone layout is pushed wider than the screen. */
const NO_BREAK = "SO-101-Hrubá-stavba-včetně-základových-pasů-a-podkladních-betonů-a-izolací";

const ids = { project: "", second: "", third: "", signedDay: pragueDay(-1), draftDay: pragueDay(0), lateDay: pragueDay(-3) };

/** Signs in through the API and returns the signed-in user (the cookie stays in [api]). */
async function apiLogin(api: APIRequestContext, nickname: string, password: string): Promise<{ id: string }> {
  const res = await api.post("/api/auth/login", { data: { nickname, password } });
  expect(res.ok(), `login of ${nickname}`).toBeTruthy();
  return (await res.json()).user;
}

async function post<T = unknown>(api: APIRequestContext, path: string, data: unknown): Promise<T> {
  const res = await api.post(path, { data });
  expect(res.ok(), `POST ${path}: ${res.status()} ${await res.text()}`).toBeTruthy();
  return (await res.json()) as T;
}

const projectBody = (name: string, siteManagerId: string) => ({
  name,
  address: LONG_ADDRESS,
  cadastralArea: "Nové Město",
  parcelNumbers: PARCELS,
  builder: "Hlavní město Praha, Odbor městského investora",
  contractor: "Stavební společnost Moravskoslezská stavební a.s.",
  permitNumber: "SZ/2026/0012345/OSU/VI-BOH",
  permitDate: "2026-03-01",
  designerName: "Ing. arch. Petr Projektant, Ph.D., Architektonický ateliér Projektant & spol.",
  tdsName: "Ing. Jan Dozor",
  bozpName: "Eva Bozpová",
  contractNumber: "SML-2026/0099",
  contractDate: "2026-02-01",
  designDocVersion: "v1.2",
  designDocDate: "2026-01-15",
  subcontractors: "Elektro s.r.o., IČO 12345678, Elektrikářská 1, Brno\nVodoinstalace Novák a syn s.r.o., IČO 87654321",
  supportingDocuments: "Smlouva o dílo č. SML-2026/0099\nStavební povolení SZ/2026/0012345",
  siteManagerId,
});

const entryBody = (date: string, extra: Record<string, unknown> = {}) => ({
  date,
  workDescription: `Betonáž stropní desky nad prvním podlažím, ${NO_BREAK}. Zedníci zdili příčky ve druhém podlaží, instalatéři vedli stoupačky.`,
  workersByTrade: JSON.stringify([
    { trade: "Zedník", count: 4, names: ["Ing. Jan Novák, Ph.D.", "Petr Svoboda", "Karel Dvořák", "Josef Procházka"] },
    { trade: "Železář a betonář (vazači výztuže)", count: 3 },
    { trade: "Elektrikář", count: 2 },
  ]),
  details: { materials: "Beton C25/30 XC1, 24 m3; výztuž B500B", machinery: "Autojeřáb 40 t, čerpadlo betonu", otherNotes: NO_BREAK },
  weather: { condition: "zataženo, občasný déšť", tempMin: 8.5, tempMax: 15 },
  isControlDay: true,
  constructionObj: NO_BREAK,
  expectNew: true,
  ...extra,
});

test.beforeAll(async () => {
  const api = await playwrightRequest.newContext({ baseURL: BASE_URL });
  try {
    const admin = await apiLogin(api, ADMIN_NICKNAME, ADMIN_PASSWORD);
    ids.project = (await post<{ id: string }>(api, "/api/projects", projectBody(LONG_NAME, admin.id))).id;
    ids.second = (await post<{ id: string }>(api, "/api/projects", projectBody("Dům U Lípy", admin.id))).id;
    ids.third = (await post<{ id: string }>(api, "/api/projects", projectBody("Hala 7", admin.id))).id;

    // Members: a manager, a worker and the investor (long login names, like real ones).
    await post(api, `/api/projects/${ids.project}/members`, { userId: "44444444-4444-4444-4444-444444444444", role: "BOSS" });
    await post(api, `/api/projects/${ids.project}/members`, { userId: "55555555-5555-5555-5555-555555555555", role: "WORKER" });
    await post(api, `/api/projects/${ids.project}/members`, { userId: "22222222-2222-2222-2222-222222222222", role: "INVESTOR" });
    await post(api, `/api/projects/${ids.project}/authorized-persons`, {
      name: "Ing. arch. Petr Černý, autorizovaný architekt ČKA",
      company: "Architekti Černý a partneři s.r.o.",
      authorization: "Autorský dozor projektanta podle § 152 stavebního zákona, včetně účasti na kontrolních prohlídkách",
    });
    await post(api, `/api/projects/${ids.project}/handovers`, {
      projectId: ids.project,
      type: "Předání staveniště zhotoviteli",
      date: pragueDay(-20),
      participants: "Ing. Jan Novák (objednatel), Petr Svoboda (zhotovitel), Ing. Eva Dozorová (technický dozor stavebníka)",
      meterStates: [
        { medium: "Elektřina VT", serialNumber: "EL-98765-4321", state: "12450 kWh" },
        { medium: "Voda studená", serialNumber: "VO-1122", state: "310 m3" },
      ],
      notes: "Staveniště předáno bez výhrad, přístupová cesta přes vrata ve dvoře.",
    });

    // Entries: a signed one, a draft for today and a late one, so the list and the page of an entry have something in them.
    await post(api, `/api/projects/${ids.project}/reports/${ids.draftDay}`, entryBody(ids.draftDay));
    await post(api, `/api/projects/${ids.project}/reports/${ids.lateDay}`, entryBody(ids.lateDay, { lateEntryReason: "Doplněno po návratu z nemoci, zápis nebyl možný dříve." }));
    const signed = await post<{ updatedAt: string }>(api, `/api/projects/${ids.project}/reports/${ids.signedDay}`, entryBody(ids.signedDay));
    await post(api, `/api/projects/${ids.project}/reports/${ids.signedDay}/sign`, { password: ADMIN_PASSWORD, expectedUpdatedAt: signed.updatedAt });
  } finally {
    await api.dispose();
  }
});

async function signIn(page: Page, nickname = ADMIN_NICKNAME, password = ADMIN_PASSWORD) {
  await page.goto("/login");
  await page.locator('input[name="nickname"]').fill(nickname);
  await page.locator('input[name="password"]').fill(password);
  await page.locator('button[type="submit"]').click();
  await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 });
}

/** The width of the page against the width of the screen, and which elements stick out (for the message of a failure). */
async function widthReport(page: Page) {
  return page.evaluate(() => {
    const root = document.documentElement;
    const viewport = root.clientWidth;
    const out: string[] = [];
    for (const el of Array.from(document.body.querySelectorAll("*"))) {
      if (getComputedStyle(el).position === "fixed") continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      if (r.right > viewport + 0.5 || r.left < -0.5) {
        const cls = typeof el.className === "string" ? el.className.split(/\s+/).slice(0, 3).join(".") : "";
        out.push(`${el.tagName.toLowerCase()}${cls ? "." + cls : ""} [${Math.round(r.left)}..${Math.round(r.right)}] "${(el.textContent ?? "").trim().slice(0, 30)}"`);
      }
    }
    return { viewport, scrollWidth: root.scrollWidth, bodyScrollWidth: document.body.scrollWidth, innerWidth: window.innerWidth, wide: out.slice(0, 6) };
  });
}

/** Nothing scrolls sideways: the page is not wider than the screen, whatever the browser does about it. */
async function expectNoSidewaysScroll(page: Page, what: string) {
  const screen = page.viewportSize()!.width;
  const r = await widthReport(page);
  const detail = `${what}: the page is ${r.scrollWidth}px wide (body ${r.bodyScrollWidth}px, window ${r.innerWidth}px) on a ${screen}px screen; sticking out: ${r.wide.join(" | ") || "nothing found"}`;
  expect.soft(r.scrollWidth, detail).toBeLessThanOrEqual(screen);
  expect.soft(r.bodyScrollWidth, detail).toBeLessThanOrEqual(screen);
}

/** Every visible field is at least 16 px: a smaller one makes iOS zoom into it when it gets the focus. */
async function expectInputsAtLeast16px(page: Page, what: string) {
  const small = await page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>("input:not([type=checkbox]):not([type=radio]):not([type=file]):not([type=hidden]), textarea, select"))
      .filter((el) => el.getClientRects().length > 0)
      .map((el) => ({ name: el.getAttribute("name") ?? el.id ?? el.tagName, size: parseFloat(getComputedStyle(el).fontSize) }))
      .filter((f) => f.size < 16)
      .map((f) => `${f.name} (${f.size}px)`),
  );
  expect.soft(small, `${what}: fields smaller than 16px`).toEqual([]);
}

/** A control is whole on the screen (not cut off at the side) and large enough to hit with a thumb. */
async function expectReachable(page: Page, control: Locator, what: string) {
  await expect.soft(control, `${what} is visible`).toBeVisible();
  const box = await control.boundingBox();
  const screen = page.viewportSize()!.width;
  expect.soft(box, `${what} has a box`).not.toBeNull();
  if (!box) return;
  expect.soft(box.x, `${what} starts on the screen`).toBeGreaterThanOrEqual(0);
  expect.soft(box.x + box.width, `${what} ends on the screen (${Math.round(box.x + box.width)}px of ${screen}px)`).toBeLessThanOrEqual(screen);
  expect.soft(box.height, `${what} is at least ${MIN_TARGET}px high (${Math.round(box.height)}px)`).toBeGreaterThanOrEqual(MIN_TARGET);
}

/** The frame every page after sign-in has: logout and the way into the other pages are on the screen. */
async function expectShell(page: Page, what: string) {
  await expectReachable(page, page.getByRole("button", { name: "Odhlásit se" }), `${what}: the logout button`);
  await expectReachable(page, page.getByRole("navigation", { name: /hlavní/i }).getByRole("link", { name: "Projekty", exact: true }), `${what}: the link to the projects`);
}

/** The checks every page after sign-in has to pass. */
async function expectPhoneReady(page: Page, what: string) {
  await expectShell(page, what);
  await expectNoSidewaysScroll(page, what);
  await expectInputsAtLeast16px(page, what);
}

test.describe("the pages at 360 px", () => {
  test("login", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "Stavební deník" })).toBeVisible();
    await expectNoSidewaysScroll(page, "the login page");
    await expectInputsAtLeast16px(page, "the login page");
    await expectReachable(page, page.locator('button[type="submit"]'), "the login button");
  });

  test("project list", async ({ page }) => {
    await signIn(page);
    await page.goto("/projects");
    await expect(page.getByText(LONG_NAME).first()).toBeVisible({ timeout: 15_000 });
    await expectPhoneReady(page, "the project list");
    await expectReachable(page, page.getByRole("link", { name: "Přidat projekt" }), "the link that adds a project");
    await expectReachable(page, page.getByRole("link", { name: LONG_NAME }), "the link that opens the diary");
  });

  test("a project: overview and every tab", async ({ page }) => {
    await signIn(page);
    await page.goto(`/projects/${ids.project}`);
    await expect(page.getByRole("heading", { name: LONG_NAME })).toBeVisible({ timeout: 15_000 });
    await expectPhoneReady(page, "the project overview");

    // Each tab can be reached from the screen (none is cut off at the side) and is a page of its own.
    const tabs: { name: RegExp; shows: Locator; what: string }[] = [
      { name: /^Přehled$/, shows: page.getByText("Informace o stavbě"), what: "overview" },
      { name: /^Záznamy$/, shows: page.getByText("Denní záznamy"), what: "entries" },
      { name: /^Předání staveniště$/, shows: page.getByText("Předání a převzetí staveniště"), what: "handovers" },
      { name: /^Členové$/, shows: page.getByText("Členové projektu"), what: "members" },
    ];
    for (const tab of tabs) {
      const link = page.getByRole("link", { name: tab.name });
      await expectReachable(page, link, `the tab ${tab.what}`);
      await link.click();
      await expect(tab.shows).toBeVisible({ timeout: 15_000 });
      await expectPhoneReady(page, `the tab ${tab.what}`);
    }
  });

  test("the entries tab with its rows, and the other tabs with their data", async ({ page }) => {
    await signIn(page);
    await page.goto(`/projects/${ids.project}?tab=reports`);
    await expect(page.getByRole("link", { name: new RegExp(`Zobrazit záznam`) }).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: `Stáhnout PDF záznamu z ${ids.signedDay}` })).toBeVisible();
    await expectPhoneReady(page, "the list of entries");
    await expectReachable(page, page.getByRole("button", { name: "Nový pro dnešek" }), "the button of a new entry");

    await page.goto(`/projects/${ids.project}?tab=handovers`);
    await expect(page.getByText("Elektřina VT")).toBeVisible({ timeout: 15_000 });
    await expectPhoneReady(page, "the handovers with their meters");

    await page.goto(`/projects/${ids.project}?tab=members`);
    await expect(page.getByText("worker@stavebni-denik.cz")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Ing. arch. Petr Černý, autorizovaný architekt ČKA", { exact: true })).toBeVisible();
    await expectPhoneReady(page, "the members and the authorised persons");
  });

  test("a daily entry: a draft, a late entry and a signed entry", async ({ page }) => {
    await signIn(page);
    for (const [day, what] of [
      [ids.draftDay, "an entry being written"],
      [ids.lateDay, "a late entry"],
      [ids.signedDay, "a signed entry"],
    ]) {
      await page.goto(`/projects/${ids.project}/reports/${day}`);
      await expect(page.getByRole("heading", { name: /Denní záznam stavby/ })).toBeVisible({ timeout: 15_000 });
      await expect(page.locator('textarea[name="workDescription"]')).toHaveValue(/Betonáž stropní desky/, { timeout: 15_000 });
      await expectPhoneReady(page, what);
    }
    // The signed one has the "Podepsáno" badge; the one in progress has the save button, which can be reached.
    await expect(page.getByText("Podepsáno", { exact: true })).toBeVisible();
    await page.goto(`/projects/${ids.project}/reports/${ids.draftDay}`);
    await expect(page.locator('textarea[name="workDescription"]')).toHaveValue(/Betonáž stropní desky/, { timeout: 15_000 });
    await expectReachable(page, page.getByRole("button", { name: /uložit změny/i }), "the save button of an entry");
  });

  test("a signed entry, as the investor reads it", async ({ browser }) => {
    const context = await browser.newContext({ baseURL: BASE_URL, viewport: { width: 360, height: 780 }, hasTouch: true, isMobile: true });
    const page = await context.newPage();
    try {
      await signIn(page, INVESTOR_NICKNAME, INVESTOR_PASSWORD);
      await page.goto(`/projects/${ids.project}/reports/${ids.signedDay}`);
      await expect(page.getByRole("heading", { name: /Denní záznam stavby/ })).toBeVisible({ timeout: 15_000 });
      await expect(page.getByRole("button", { name: "Potvrdit seznámení" })).toBeVisible({ timeout: 15_000 });
      await expectPhoneReady(page, "a signed entry, seen by the investor");
      await expectReachable(page, page.getByRole("button", { name: "Potvrdit seznámení" }), "the button that acknowledges an entry");
    } finally {
      await context.close();
    }
  });

  test("new project and the identification form", async ({ page }) => {
    await signIn(page);
    await page.goto("/projects/new");
    await expect(page.getByRole("heading", { name: "Nový projekt / zakázka" })).toBeVisible();
    await expectPhoneReady(page, "the new project form");
    await expectReachable(page, page.getByRole("button", { name: "Založit zakázku" }), "the button that creates a project");

    await page.goto(`/projects/${ids.project}/edit`);
    await expect(page.locator('input[name="name"]')).toHaveValue(LONG_NAME, { timeout: 15_000 });
    await expectPhoneReady(page, "the identification form of a project");
  });

  test("administration: users and the audit log", async ({ page }) => {
    await signIn(page);
    await page.goto("/admin/users");
    await expect(page.getByText("manager@stavebni-denik.cz")).toBeVisible({ timeout: 15_000 });
    await expectPhoneReady(page, "the users");
    await expectReachable(page, page.getByRole("button", { name: "Nový uživatel" }), "the button that adds a user");
    // Every action on a user can be reached.
    const row = page.locator("tr", { hasText: "manager@stavebni-denik.cz" });
    for (const action of ["Upravit", "Obnovit heslo", "Deaktivovat", "Smazat"]) {
      await expectReachable(page, row.getByRole("button", { name: action, exact: true }), `the action "${action}" on a user`);
    }

    await page.goto("/admin/audit");
    await expect(page.getByText("project.create").first()).toBeVisible({ timeout: 15_000 });
    await expectPhoneReady(page, "the audit log");
  });

  test("change password", async ({ page }) => {
    await signIn(page);
    await page.goto("/change-password");
    await expect(page.getByRole("heading", { name: "Změna hesla" })).toBeVisible();
    await expectPhoneReady(page, "the change-password form");
    await expectReachable(page, page.getByRole("button", { name: "Změnit heslo" }), "the button that changes the password");
  });

  test("dialogs fit the screen", async ({ page }) => {
    await signIn(page);
    await page.goto("/admin/users");
    await page.getByRole("button", { name: "Nový uživatel" }).click();
    const panel = page.getByRole("heading", { name: "Vytvořit nového uživatele" }).locator("xpath=..");
    await expect(panel).toBeVisible();
    const box = (await panel.boundingBox())!;
    expect.soft(box.x, "the dialog starts on the screen").toBeGreaterThanOrEqual(0);
    expect.soft(box.x + box.width, "the dialog ends on the screen").toBeLessThanOrEqual(360);
    await expectNoSidewaysScroll(page, "the new-user dialog");
    await expectInputsAtLeast16px(page, "the new-user dialog");
  });
});
