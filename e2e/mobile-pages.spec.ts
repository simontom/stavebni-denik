import { expect, test, type APIRequestContext, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { ADMIN_NICKNAME, ADMIN_PASSWORD, INVESTOR_NICKNAME, INVESTOR_PASSWORD } from "./global-setup";

/**
 * The phone projects (`playwright.config.ts`: 360 x 780 held upright, and 780 x 360 held sideways, both with a touch screen): every
 * main page is visited with realistic data (long names, words that cannot be broken, many rows, an entry full of text, a signed
 * entry) and must
 *  - not scroll sideways (the browser would otherwise shrink the whole page to fit, or hide what is off the screen),
 *  - keep the primary controls (logout, the way into the pages) on the screen,
 *  - have every button and every field at least 44 px high, and every field at least 16 px (iOS zooms into a smaller one).
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

/** `2026-09-28` as the pages print it without the weekday: `28. 9. 2026`. */
function czDay(iso: string): string {
  const [year, month, day] = iso.split("-").map(Number);
  return `${day}. ${month}. ${year}`;
}

/**
 * A word of exactly [length] letters: no space, no hyphen, nothing the browser may break a line at. Only such a word shows whether a
 * page lets a long word push it wider than the screen (a hyphen or a space is a place to break, and hides the problem).
 */
function oneWord(length: number, start: string): string {
  return (start + "abcdefghijklmnopqrstuvwxyz".repeat(8)).slice(0, length);
}

/** The run, as letters only (the local database keeps what earlier runs made, so every name has to be new). */
function runLetters(): string {
  return [...String(Date.now())].map((digit) => "abcdefghij"[Number(digit)]).join("");
}

const data = {
  // A project name of 63 letters, an address of 70, the people and things of an entry of 100, a login name of 63 (the longest the server
  // takes is 64), an e-mail address of 86 for a name: none of them has a place to break a line.
  projectName: "",
  address: "",
  nickname: "",
  displayName: "",
  userId: "",
  workerName: "",
  constructionObject: "",
  participants: "",
  authorizedPerson: "",
  unbrokenDescription: "",
  project: "",
  signedDay: pragueDay(-1),
  draftDay: pragueDay(0),
  lateDay: pragueDay(-3),
};

async function post<T = unknown>(api: APIRequestContext, path: string, body: unknown): Promise<T> {
  const res = await api.post(path, { data: body });
  expect(res.ok(), `POST ${path}: ${res.status()} ${await res.text()}`).toBeTruthy();
  return (await res.json()) as T;
}

const PARCELS = Array.from({ length: 30 }, (_, i) => `450/${i + 1}`).join(", ");

const projectBody = (name: string, siteManagerId: string) => ({
  name,
  address: data.address,
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
  workDescription: `Betonáž stropní desky nad prvním podlažím, ${data.unbrokenDescription} zedníci zdili příčky ve druhém podlaží, instalatéři vedli stoupačky.`,
  workersByTrade: JSON.stringify([
    { trade: "Zedník", count: 4, names: [data.workerName, "Ing. Jan Novák, Ph.D.", "Petr Svoboda", "Karel Dvořák"] },
    { trade: "Železář a betonář (vazači výztuže)", count: 3 },
    { trade: "Elektrikář", count: 2 },
  ]),
  details: { materials: "Beton C25/30 XC1, 24 m3; výztuž B500B", machinery: "Autojeřáb 40 t, čerpadlo betonu", otherNotes: data.unbrokenDescription },
  weather: { condition: "zataženo, občasný déšť", tempMin: 8.5, tempMax: 15 },
  isControlDay: true,
  constructionObj: data.constructionObject,
  expectNew: true,
  ...extra,
});

let seedContext: BrowserContext | null = null;

// Signed in through the page (a real browser context takes the session cookie the way the application does, also a Secure one on the
// built image), then the data is made with that context's API requests.
test.beforeAll(async ({ browser }) => {
  const run = runLetters();
  data.projectName = oneWord(63, `Projekt${run}`);
  data.address = oneWord(70, `Adresa${run}`);
  data.nickname = oneWord(63, `uzivatel${run}`);
  data.displayName = `${oneWord(41, `jmeno${run}`)}@${oneWord(41, `firma${run}`)}.cz`;
  data.workerName = oneWord(100, `Pracovnik${run}`);
  data.constructionObject = oneWord(100, `Objekt${run}`);
  data.participants = oneWord(100, `Ucastnik${run}`);
  data.authorizedPerson = oneWord(120, `Osoba${run}`);
  data.unbrokenDescription = oneWord(100, `Popis${run}`);

  const context = await browser.newContext({ baseURL: BASE_URL });
  seedContext = context;
  const page = await context.newPage();
  await signIn(page);
  const admin = JSON.parse((await page.evaluate(() => localStorage.getItem("user"))) ?? "null") as { id: string };
  const api = context.request;
  data.project = (await post<{ id: string }>(api, "/api/projects", projectBody(data.projectName, admin.id))).id;
  await post(api, "/api/projects", projectBody("Dům U Lípy", admin.id));
  await post(api, "/api/projects", projectBody("Hala 7", admin.id));

  // A person whose login name and e-mail address have no place to break, a manager, a worker and the investor.
  const created = await post<{ user: { id: string } }>(api, "/api/users", { nickname: data.nickname, displayName: data.displayName, role: "WORKER", ckaitNumber: "" });
  data.userId = created.user.id;
  await post(api, `/api/projects/${data.project}/members`, { userId: data.userId, role: "WORKER" });
  await post(api, `/api/projects/${data.project}/members`, { userId: "44444444-4444-4444-4444-444444444444", role: "BOSS" });
  await post(api, `/api/projects/${data.project}/members`, { userId: "55555555-5555-5555-5555-555555555555", role: "WORKER" });
  await post(api, `/api/projects/${data.project}/members`, { userId: "22222222-2222-2222-2222-222222222222", role: "INVESTOR" });
  await post(api, `/api/projects/${data.project}/authorized-persons`, {
    name: data.authorizedPerson,
    company: "Architekti Černý a partneři s.r.o.",
    authorization: "Autorský dozor projektanta podle § 152 stavebního zákona, včetně účasti na kontrolních prohlídkách",
  });
  await post(api, `/api/projects/${data.project}/handovers`, {
    projectId: data.project,
    type: "Předání staveniště zhotoviteli",
    date: pragueDay(-20),
    participants: data.participants,
    meterStates: [
      { medium: "Elektřina VT", serialNumber: "EL-98765-4321", state: "12450 kWh" },
      { medium: "Voda studená", serialNumber: "VO-1122", state: "310 m3" },
    ],
    notes: "Staveniště předáno bez výhrad, přístupová cesta přes vrata ve dvoře.",
  });

  // Entries: a signed one, a draft for today and a late one, so the list and the page of an entry have something in them.
  await post(api, `/api/projects/${data.project}/reports/${data.draftDay}`, entryBody(data.draftDay));
  await post(api, `/api/projects/${data.project}/reports/${data.lateDay}`, entryBody(data.lateDay, { lateEntryReason: "Doplněno po návratu z nemoci, zápis nebyl možný dříve." }));
  const signed = await post<{ updatedAt: string }>(api, `/api/projects/${data.project}/reports/${data.signedDay}`, entryBody(data.signedDay));
  await post(api, `/api/projects/${data.project}/reports/${data.signedDay}/sign`, { password: ADMIN_PASSWORD, expectedUpdatedAt: signed.updatedAt });
});

// The account made for the run is deleted again (its project stays: every run gives its project a name of its own).
test.afterAll(async () => {
  try {
    if (seedContext && data.userId) await seedContext.request.delete(`/api/users/${data.userId}`);
  } finally {
    await seedContext?.close();
    seedContext = null;
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

/** Every visible button and every one-line field is at least 44 px high: a thumb has to hit it. */
async function expectControlsAtLeast44px(page: Page, what: string) {
  const small = await page.evaluate((min) => {
    const controls = document.querySelectorAll<HTMLElement>("button, select, input:not([type=checkbox]):not([type=radio]):not([type=file]):not([type=hidden]):not([type=range])");
    return Array.from(controls)
      .filter((el) => el.getClientRects().length > 0)
      .map((el) => ({
        name: (el.getAttribute("aria-label") ?? el.getAttribute("name") ?? el.textContent ?? el.tagName).trim().slice(0, 40),
        height: el.getBoundingClientRect().height,
      }))
      .filter((c) => c.height < min - 0.5)
      .map((c) => `${c.name} (${Math.round(c.height)}px)`);
  }, MIN_TARGET);
  expect.soft(small, `${what}: controls lower than ${MIN_TARGET}px`).toEqual([]);
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

/** The frame every page after sign-in has: logout, top right, and the way into the other pages are on the screen. */
async function expectShell(page: Page, what: string) {
  const logout = page.getByRole("button", { name: "Odhlásit se" });
  await expectReachable(page, logout, `${what}: the logout button`);
  // Logout stays in the top right corner whatever the width (it used to wrap alone to the left of the second row)
  const box = await logout.boundingBox();
  const screen = page.viewportSize()!.width;
  if (box) {
    expect.soft(box.y, `${what}: logout is on the first row (${Math.round(box.y)}px from the top)`).toBeLessThan(60);
    expect.soft(screen - (box.x + box.width), `${what}: logout is at the right edge (${Math.round(screen - box.x - box.width)}px from it)`).toBeLessThanOrEqual(40);
  }
  await expectReachable(page, page.getByRole("navigation", { name: /hlavní/i }).getByRole("link", { name: "Projekty", exact: true }), `${what}: the link to the projects`);
}

/** The checks every page after sign-in has to pass. */
async function expectPhoneReady(page: Page, what: string) {
  await expectShell(page, what);
  await expectNoSidewaysScroll(page, what);
  await expectInputsAtLeast16px(page, what);
  await expectControlsAtLeast44px(page, what);
}

test.describe("the pages on a phone", () => {
  test("login", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "Stavební deník" })).toBeVisible();
    // The touch rules follow the pointer: this is a finger, whatever the width of the screen
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
    await expectNoSidewaysScroll(page, "the login page");
    await expectInputsAtLeast16px(page, "the login page");
    await expectControlsAtLeast44px(page, "the login page");
    await expectReachable(page, page.locator('button[type="submit"]'), "the login button");
  });

  test("project list", async ({ page }) => {
    await signIn(page);
    await page.goto("/projects");
    await expect(page.getByText(data.projectName).first()).toBeVisible({ timeout: 15_000 });
    await expectPhoneReady(page, "the project list");
    await expectReachable(page, page.getByRole("link", { name: "Přidat projekt" }), "the link that adds a project");
    await expectReachable(page, page.getByRole("link", { name: data.projectName }), "the link that opens the diary");
    // The state of today's entry is on the card, as a link of its own that a thumb can hit (the project of the run has a draft for today).
    const card = page.getByRole("listitem").filter({ hasText: data.projectName });
    await expectReachable(page, card.getByRole("link", { name: "Dnes: rozpracováno" }), "the link to today's entry on the card");
    // A card with no entry for today says so (the other two projects of the run)
    await expect(page.getByText("Dnes: nezapsáno").first()).toBeVisible();
  });

  test("a project: overview and every tab", async ({ page }) => {
    await signIn(page);
    await page.goto(`/projects/${data.project}`);
    await expect(page.getByRole("heading", { name: data.projectName })).toBeVisible({ timeout: 15_000 });
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

  test("the current tab is told apart by more than its colour", async ({ page }) => {
    await signIn(page);
    await page.goto(`/projects/${data.project}`);
    await expect(page.getByRole("heading", { name: data.projectName })).toBeVisible({ timeout: 15_000 });
    const look = (link: Locator) =>
      link.evaluate((el) => {
        const style = getComputedStyle(el);
        return {
          underline: style.textDecorationLine.includes("underline"),
          weight: Number(style.fontWeight),
          // a line that can be seen: it has a width and a colour that is not transparent
          lineBelow: parseFloat(style.borderBottomWidth) >= 2 && style.borderBottomColor !== "rgba(0, 0, 0, 0)",
        };
      });
    const current = page.getByRole("link", { name: /^Přehled$/ });
    const other = page.getByRole("link", { name: /^Záznamy$/ });
    await expect(current).toHaveAttribute("aria-current", "page");
    await expect(other).not.toHaveAttribute("aria-current", "page");
    const [now, then] = [await look(current), await look(other)];
    // bolder, in every width
    expect(now.weight, "the current tab is bolder").toBeGreaterThan(then.weight);
    if (page.viewportSize()!.width < 640) {
      // the tabs are a grid of boxes: the current one is underlined
      expect(now.underline, "the current tab is underlined").toBe(true);
      expect(then.underline, "the others are not").toBe(false);
    } else {
      // the tabs are a row: the current one has a line under it, the others have none
      expect(now.lineBelow, "the current tab has a line under it").toBe(true);
      expect(then.lineBelow, "the others have none").toBe(false);
    }
  });

  test("the entries tab with its rows, and the other tabs with their data", async ({ page }) => {
    await signIn(page);
    await page.goto(`/projects/${data.project}?tab=reports`);
    // One row per entry; its link says the day with the weekday and the number, and the row says who wrote it and in what state it is.
    const signedRow = page.getByRole("listitem").filter({ hasText: czDay(data.signedDay) });
    await expect(signedRow.getByRole("link", { name: /Záznam č\. \d/ })).toBeVisible({ timeout: 15_000 });
    await expect(signedRow.getByText("Autor: E2E Admin")).toBeVisible();
    await expect(signedRow.getByText("Podepsáno", { exact: true })).toBeVisible();
    await expect(
      page
        .getByRole("listitem")
        .filter({ hasText: czDay(data.lateDay) })
        .getByText("Pozdní zápis", { exact: true }),
    ).toBeVisible();
    await expect(
      page
        .getByRole("listitem")
        .filter({ hasText: czDay(data.draftDay) })
        .getByText("Rozpracováno", { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: `Stáhnout PDF záznamu z ${czDay(data.signedDay)}` })).toBeVisible();
    await expectPhoneReady(page, "the list of entries");
    await expectReachable(page, signedRow.getByRole("link", { name: /Záznam č\. \d/ }), "the link of a row");
    await expectReachable(page, page.getByRole("button", { name: "Nový pro dnešek" }), "the button of a new entry");

    await page.goto(`/projects/${data.project}?tab=handovers`);
    await expect(page.getByText("Elektřina VT")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(data.participants)).toBeVisible();
    await expectPhoneReady(page, "the handovers with their meters");

    await page.goto(`/projects/${data.project}?tab=members`);
    await expect(page.getByText("worker@stavebni-denik.cz")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(data.nickname)).toBeVisible();
    await expect(page.getByText(data.displayName)).toBeVisible();
    await expect(page.getByText(data.authorizedPerson, { exact: true })).toBeVisible();
    await expectPhoneReady(page, "the members and the authorised persons");
  });

  test("a daily entry: a draft, a late entry and a signed entry", async ({ page }) => {
    await signIn(page);
    for (const [day, what] of [
      [data.draftDay, "an entry being written"],
      [data.lateDay, "a late entry"],
      [data.signedDay, "a signed entry"],
    ]) {
      await page.goto(`/projects/${data.project}/reports/${day}`);
      await expect(page.getByRole("heading", { name: /Denní záznam stavby/ })).toBeVisible({ timeout: 15_000 });
      if (day === data.signedDay) {
        // A signed entry is a document: the text, not a field with it in.
        await expect(page.getByText(/Betonáž stropní desky/)).toBeVisible({ timeout: 15_000 });
        await expect(page.locator('textarea[name="workDescription"]')).toHaveCount(0);
      } else {
        await expect(page.locator('textarea[name="workDescription"]')).toHaveValue(/Betonáž stropní desky/, { timeout: 15_000 });
      }
      // the construction object is in a badge: a word of 100 letters has to wrap in it
      await expect(page.getByText(data.constructionObject).first()).toBeVisible();
      await expectPhoneReady(page, what);
    }
    // The signed one has the "Podepsáno" badge, and the card of the signature on the screen with the button that verifies it; the one in
    // progress has the save button, which can be reached.
    await page.goto(`/projects/${data.project}/reports/${data.signedDay}`);
    await expect(page.getByText("Podepsáno", { exact: true })).toHaveCount(1, { timeout: 15_000 });
    await expect(page.getByRole("region", { name: "Podpis záznamu" }).getByText(/ČKAIT 0000000/)).toBeVisible();
    await expectReachable(page, page.getByRole("button", { name: "Ověřit podpis" }), "the button that verifies the signature");
    // the people of the trades are in a table that becomes a list on a phone: a name of 100 letters does not widen the page
    await expect(page.getByText(data.workerName).first()).toBeVisible();
    await page.goto(`/projects/${data.project}/reports/${data.draftDay}`);
    await expect(page.locator('textarea[name="workDescription"]')).toHaveValue(/Betonáž stropní desky/, { timeout: 15_000 });
    await expectReachable(page, page.getByRole("button", { name: /uložit změny/i }), "the save button of an entry");
    // the buttons and fields of the form itself: removing a trade, the names of the people, the trades, the weather
    await expectReachable(page, page.getByRole("button", { name: "Odebrat" }).first(), "the button that removes a trade");
  });

  test("a signed entry, as the investor reads it", async ({ browser }, testInfo) => {
    const { viewport, isMobile, hasTouch, deviceScaleFactor } = testInfo.project.use;
    const context = await browser.newContext({ baseURL: BASE_URL, viewport, isMobile, hasTouch, deviceScaleFactor });
    const page = await context.newPage();
    try {
      await signIn(page, INVESTOR_NICKNAME, INVESTOR_PASSWORD);
      await page.goto(`/projects/${data.project}/reports/${data.signedDay}`);
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

    await page.goto(`/projects/${data.project}/edit`);
    await expect(page.locator('input[name="name"]')).toHaveValue(data.projectName, { timeout: 15_000 });
    await expectPhoneReady(page, "the identification form of a project");
  });

  test("administration: users and the audit log", async ({ page }) => {
    await signIn(page);
    await page.goto("/admin/users");
    await expect(page.getByText("manager@stavebni-denik.cz")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(data.nickname)).toBeVisible();
    await expectPhoneReady(page, "the users");
    // The list does not scroll inside its box either: a login name of 63 letters wraps in its card
    const box = page.locator("table").first().locator("xpath=..");
    expect(await box.evaluate((el) => el.scrollWidth - el.clientWidth), "the list of users does not scroll sideways inside its box").toBeLessThanOrEqual(1);
    await expectReachable(page, page.getByRole("button", { name: "Nový uživatel" }), "the button that adds a user");
    // Every action on a user can be reached
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
    const screen = page.viewportSize()!.width;
    expect.soft(box.x, "the dialog starts on the screen").toBeGreaterThanOrEqual(0);
    expect.soft(box.x + box.width, "the dialog ends on the screen").toBeLessThanOrEqual(screen);
    await expectNoSidewaysScroll(page, "the new-user dialog");
    await expectInputsAtLeast16px(page, "the new-user dialog");
    await expectControlsAtLeast44px(page, "the new-user dialog");
  });
});
