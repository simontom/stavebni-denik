import { expect, test, type Locator, type Page, type Request, type Route } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { ADMIN_PASSWORD } from "./global-setup";
import { makeProject, pragueDay, saveEntry, signInAdmin } from "./helpers";

/**
 * The field ergonomics of the daily entry (backlog B5), on a desktop: the weather chips, the total of the workers, the previous and the
 * next day, the one bar of actions that follows the state of the entry, the detail fields that grow while they are written in, and
 * several photos at once. What a phone adds (the bar above the safe area, hidden while a keyboard is open, 44 px targets) is in
 * `mobile-entry-ergonomics.spec.ts`; the logic behind every one of these is unit tested (`frontend/src/lib`).
 *
 * Photo removal is not part of this: it waits for the owner's decision (backlog A4).
 */

const entryUrl = (projectPath: string, day: string) => `${projectPath}/reports/${day}`;
const description = (page: Page) => page.locator('textarea[name="workDescription"]');
const bar = (page: Page) => page.getByRole("region", { name: "Akce záznamu" });
const JPEG = fs.readFileSync(path.resolve(__dirname, "fixtures/dummy-photo.jpg"));

async function openNewDay(page: Page, label: string, day = pragueDay(0)) {
  await signInAdmin(page);
  const project = await makeProject(page, label);
  await page.goto(entryUrl(project.projectPath, day));
  await expect(description(page)).toBeEditable({ timeout: 15_000 });
  return { ...project, day };
}

test.describe("the weather chips", () => {
  test("put a condition into the text of the weather, take it out again, keep what was typed, and are saved as plain text", async ({ page }) => {
    test.setTimeout(90_000);
    const { projectId, day } = await openNewDay(page, "Chips");
    const text = page.locator('input[name="weatherCondition"]');
    const chips = page.getByRole("group", { name: "Rychlý výběr počasí" });
    const chip = (name: string) => chips.getByRole("button", { name, exact: true });

    // real buttons, none pressed while the text says nothing
    await expect(chips).toBeVisible();
    for (const name of ["jasno", "polojasno", "zataženo", "déšť", "sněžení", "bouřka", "mráz", "silný vítr"]) {
      await expect(chip(name)).toHaveAttribute("aria-pressed", "false");
    }

    await chip("zataženo").click();
    await expect(text).toHaveValue("zataženo");
    await expect(chip("zataženo")).toHaveAttribute("aria-pressed", "true");
    await chip("déšť").click();
    await expect(text).toHaveValue("zataženo, déšť");
    await expect(chip("déšť")).toHaveAttribute("aria-pressed", "true");

    // free text stays possible: the person's own words are not touched by a chip, and typing is followed by the chips
    await text.fill("zataženo, déšť, staveniště rozmoklé");
    await chip("déšť").click();
    await expect(text).toHaveValue("zataženo, staveniště rozmoklé");
    await expect(chip("déšť")).toHaveAttribute("aria-pressed", "false");
    await text.fill("Mráz");
    await expect(chip("mráz")).toHaveAttribute("aria-pressed", "true");
    await text.fill("polojasno, déšť");
    await expect(chip("polojasno")).toHaveAttribute("aria-pressed", "true");
    await expect(chip("jasno")).toHaveAttribute("aria-pressed", "false");

    // from the keyboard: Space and Enter press a chip, Tab reaches the next one
    await chip("bouřka").focus();
    await page.keyboard.press("Space");
    await expect(text).toHaveValue("polojasno, déšť, bouřka");
    await page.keyboard.press("Tab");
    await expect(chip("sněžení")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(text).toHaveValue("polojasno, déšť, bouřka, sněžení");
    await page.keyboard.press("Space");
    await expect(text).toHaveValue("polojasno, déšť, bouřka");

    // what is stored is the text as it stands, and the signed weather text is made of it
    await text.fill("polojasno, déšť");
    await page.locator('input[name="weatherMin"]').fill("8.5");
    await page.locator('input[name="weatherMax"]').fill("15");
    await description(page).fill("Práce za deště");
    const saved = page.waitForResponse((r) => r.request().method() === "POST" && r.url().includes(`/reports/${day}`));
    await bar(page).getByRole("button", { name: "Uložit záznam", exact: true }).click();
    const entry = (await (await saved).json()) as { weatherText: string };
    expect(entry.weatherText).toMatch(/^polojasno, déšť, /);
    const stored = await page.request.get(`/api/projects/${projectId}/reports/${day}`);
    expect(((await stored.json()) as { weatherText: string }).weatherText).toContain("polojasno, déšť");
    await page.reload();
    await expect(text).toHaveValue("polojasno, déšť", { timeout: 15_000 });
    await expect(chip("déšť")).toHaveAttribute("aria-pressed", "true");
  });
});

test.describe("the weather chips leave what was typed alone", () => {
  test("a tap does not tidy the commas, the spaces or the case of the text, and at 200 characters it says that nothing more fits", async ({ page }) => {
    test.setTimeout(90_000);
    await openNewDay(page, "Chips minimal");
    const text = page.locator('input[name="weatherCondition"]');
    const chips = page.getByRole("group", { name: "Rychlý výběr počasí" });
    const chip = (name: string) => chips.getByRole("button", { name, exact: true });

    // untidy text stays as it is, and the word goes at the end
    await text.fill("  ,,Zataženo ,   mlha ,");
    await chip("jasno").click();
    await expect(text).toHaveValue("  ,,Zataženo ,   mlha , jasno");
    // only that word goes, with one comma
    await chip("mlha").click();
    await expect(text).toHaveValue("  ,,Zataženo ,   jasno");
    await expect(chip("zataženo")).toHaveAttribute("aria-pressed", "true"); // "Zataženo" is the word, in the case it was typed
    await chip("zataženo").click();
    await expect(text).not.toHaveValue(/Zataženo/);

    // at the limit nothing is added, and the person is told in words (a status that is there all the time, so it is announced)
    const note = page.getByRole("status").filter({ hasText: "Nejvýše 200 znaků" });
    await text.fill("x".repeat(197));
    await chip("déšť").click();
    await expect(text).toHaveValue("x".repeat(197));
    await expect(note).toBeVisible();
    // the message goes with the next change of the text, and a word can still be taken out at the limit
    await text.fill(`${"x".repeat(194)}, déšť`);
    await expect(note).toHaveCount(0);
    await expect(chip("déšť")).toHaveAttribute("aria-pressed", "true");
    await chip("déšť").click();
    await expect(text).toHaveValue("x".repeat(194));
  });
});

test.describe("the total of the workers", () => {
  test("is under the trades, follows the head counts as they are typed, speaks Czech, and is said to a screen reader once the typist has stopped", async ({ page }) => {
    test.setTimeout(90_000);
    await openNewDay(page, "Total");
    const total = page.locator("#worker-total");
    // what a screen reader is told: a polite status that settles (on a pause or when the field is left), not at every key
    const said = page.getByRole("status").filter({ hasText: "Celkem:" });
    const count = (n: number) => page.locator('input[name="workerCount"]').nth(n);

    await expect(total).toHaveText("Celkem: 0 pracovníků");
    await page.locator('input[name="workerTrade"]').first().fill("Zedník");
    await count(0).pressSequentially("1");
    await expect(total).toHaveText("Celkem: 1 pracovník");
    await count(0).fill("2");
    await expect(total).toHaveText("Celkem: 2 pracovníci");

    await page.getByRole("button", { name: /přidat profesi/i }).click();
    await page.locator('input[name="workerTrade"]').nth(1).fill("Tesař");
    await count(0).fill("5");
    await count(1).fill("7");
    await expect(total).toHaveText("Celkem: 12 pracovníků");

    // the visible total is live; what is said waits: still the old sentence right after typing, the new one when the field is left
    await count(1).fill("");
    await count(1).pressSequentially("10", { delay: 30 });
    await expect(total).toHaveText("Celkem: 15 pracovníků");
    await expect(said).not.toHaveText("Celkem: 15 pracovníků");
    await page.keyboard.press("Tab");
    await expect(said).toHaveText("Celkem: 15 pracovníků");
    // and without leaving the field, after a pause
    await count(1).fill("1");
    await expect(total).toHaveText("Celkem: 6 pracovníků");
    await expect(said).toHaveText("Celkem: 6 pracovníků", { timeout: 5_000 });

    // a row that cannot be counted is left out and said in words; a count of 0 is a count
    await count(1).fill("");
    await expect(total).toHaveText("Celkem: 5 pracovníků (u 1 profese chybí název nebo platný počet)");
    await count(1).fill("0");
    await expect(total).toHaveText("Celkem: 5 pracovníků");
    await count(1).fill("-3");
    await expect(total).toContainText("(u 1 profese chybí");
    await page.getByRole("button", { name: "Odebrat profesi 2" }).click();
    await expect(total).toHaveText("Celkem: 5 pracovníků");

    // what the server takes is 0 to 100 000 for a trade: 100 000 is counted, 100 001 is not (it would end in a 400), and the save says so before it sends anything
    await count(0).fill("100000");
    await expect(total).toHaveText("Celkem: 100000 pracovníků");
    await count(0).fill("100001");
    await expect(total).toHaveText("Celkem: 0 pracovníků (u 1 profese chybí název nebo platný počet)");
    await page.locator('textarea[name="workDescription"]').fill("Práce");
    await bar(page).getByRole("button", { name: "Uložit záznam", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: /Zadejte počet pracovníků/ })).toContainText(/od 0 do 100\s000/);
  });
});

test.describe("the previous and the next day", () => {
  test("are real links in the head of the entry, go through the router, and never lead past today", async ({ page }) => {
    test.setTimeout(90_000);
    const { projectPath } = await openNewDay(page, "Days");
    const today = pragueDay(0);
    const yesterday = pragueDay(-1);
    const days = page.getByRole("navigation", { name: "Dny záznamů" });
    const previous = days.getByRole("link", { name: /Předchozí den/ });
    const next = days.getByRole("link", { name: /Následující den/ });

    // on today: back is a link, forward does not exist
    await expect(previous).toHaveAttribute("href", entryUrl(projectPath, yesterday));
    await expect(next).toHaveCount(0);
    expect((await previous.boundingBox())!.height).toBeGreaterThanOrEqual(44);

    // the page of the other day is a fresh one (one page per day), and from it the way forward is today
    await previous.click();
    await expect(page).toHaveURL(new RegExp(`/reports/${yesterday}$`));
    await expect(page.getByRole("heading", { level: 1 })).toContainText(String(Number(yesterday.slice(8))));
    await expect(next).toHaveAttribute("href", entryUrl(projectPath, today));
    await next.click();
    await expect(page).toHaveURL(new RegExp(`/reports/${today}$`));
    await expect(next).toHaveCount(0);

    // from the keyboard: Tab to the link and Enter
    await previous.focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`/reports/${yesterday}$`));

    // a day that has not come yet can be reached only by its address; there is no way further, only back to today
    await page.goto(entryUrl(projectPath, pragueDay(1)));
    await expect(days.getByRole("link", { name: /Předchozí den/ })).toHaveAttribute("href", entryUrl(projectPath, today));
    await expect(days.getByRole("link", { name: /Následující den/ })).toHaveCount(0);
  });

  test("ask first when the text on the page would be left behind, and take it along as a draft when the person goes", async ({ page }) => {
    test.setTimeout(90_000);
    const { projectPath } = await openNewDay(page, "Days leave");
    const today = pragueDay(0);
    const yesterday = pragueDay(-1);
    await description(page).fill("Rozepsaný záznam, který se nesmí ztratit");

    const previous = page.getByRole("navigation", { name: "Dny záznamů" }).getByRole("link", { name: /Předchozí den/ });
    await previous.click();
    const ask = page.getByRole("dialog", { name: "Neuložené změny" });
    await expect(ask).toBeVisible();
    await ask.getByRole("button", { name: "Zůstat" }).click();
    await expect(page).toHaveURL(new RegExp(`/reports/${today}$`));
    await expect(description(page)).toHaveValue("Rozepsaný záznam, který se nesmí ztratit");

    await previous.click();
    await page.getByRole("dialog", { name: "Neuložené změny" }).getByRole("button", { name: "Odejít bez uložení" }).click();
    await expect(page).toHaveURL(new RegExp(`/reports/${yesterday}$`));
    // one page per day: the text of today is not in the form of yesterday
    await expect(description(page)).toHaveValue("");
    await page.goto(entryUrl(projectPath, today));
    await expect(page.getByRole("heading", { name: "Našli jsme rozepsaný záznam" })).toBeVisible({ timeout: 15_000 });
  });
});

test.describe("the bar of actions follows the state of the entry", () => {
  test("is 'Uložit záznam' for a new entry, 'Uložit změny' for changes, the signing and the PDF for a saved one, and the PDF only for a signed one", async ({ page }) => {
    test.setTimeout(120_000);
    const { projectId, day } = await openNewDay(page, "Bar");
    const buttons = (name: string | RegExp) => bar(page).getByRole("button", { name });
    await expect(bar(page)).toBeVisible();

    // no entry yet: the save is the action; the signing waits (and says why); there is nothing to download
    await expect(buttons("Uložit záznam")).toBeEnabled();
    await expect(buttons(/podepsat a uzamknout/i)).toBeDisabled();
    await expect(buttons("Stáhnout PDF")).toHaveCount(0);

    await description(page).fill("První verze");
    await expect(bar(page).getByText("Neuložené změny")).toBeVisible();
    const first = page.waitForResponse((r) => r.request().method() === "POST" && r.url().includes(`/reports/${day}`));
    await buttons("Uložit záznam").click();
    expect((await first).ok()).toBeTruthy();

    // saved, nothing changed: the signing is the action, with the PDF; the save is still there, quiet
    await expect(bar(page).getByRole("status")).toHaveText(/Uloženo \d{1,2}:\d{2}/);
    await expect(buttons(/podepsat a uzamknout/i)).toBeEnabled();
    await expect(buttons("Stáhnout PDF")).toBeEnabled();
    await expect(buttons("Uložit změny")).toBeEnabled();
    await expect(buttons("Uložit záznam")).toHaveCount(0);

    // a change: the save is the action again, the signing and the PDF of what is not the stored text are off
    await description(page).fill("První verze, změněná");
    await expect(buttons(/podepsat a uzamknout/i)).toBeDisabled();
    await expect(buttons("Stáhnout PDF")).toHaveCount(0);
    await expect(bar(page).getByText("Neuložené změny")).toBeVisible();
    const second = page.waitForResponse((r) => r.request().method() === "POST" && r.url().includes(`/reports/${day}`));
    await buttons("Uložit změny").click();
    expect((await second).ok()).toBeTruthy();
    await expect(buttons(/podepsat a uzamknout/i)).toBeEnabled();

    // the PDF is the entry as it is stored
    const download = page.waitForEvent("download", { timeout: 30_000 });
    await buttons("Stáhnout PDF").click();
    expect((await download).suggestedFilename()).toBe(`stavebni-denik-${day}.pdf`);

    // the signing, from the bar: afterwards the entry is a document and the bar has the PDF only
    await buttons(/podepsat a uzamknout/i).click();
    const dialog = page.getByRole("dialog", { name: /podepsat a uzamknout záznam/i });
    await dialog.getByLabel("Heslo").fill(ADMIN_PASSWORD);
    const signed = page.waitForResponse((r) => r.request().method() === "POST" && r.url().includes("/sign"));
    await dialog.getByRole("button", { name: "Podepsat", exact: true }).click();
    expect((await signed).ok()).toBeTruthy();
    await expect(page.getByText("Podepsáno", { exact: true })).toHaveCount(1, { timeout: 15_000 });
    await expect(bar(page)).toBeVisible();
    await expect(bar(page).getByRole("button")).toHaveCount(1);
    await expect(buttons("Stáhnout PDF")).toBeEnabled();
    await expect(page.getByRole("button", { name: /uložit (záznam|změny)/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /podepsat a uzamknout/i })).toHaveCount(0);

    // a signed entry opened afresh: the same bar
    await page.goto(entryUrl(`/projects/${projectId}`, day));
    await expect(page.getByText("Podepsáno", { exact: true })).toHaveCount(1, { timeout: 15_000 });
    await expect(bar(page).getByRole("button")).toHaveCount(1);
  });

  test("stays at the foot of the window while the entry is long, ends the page without covering anything, and takes its buttons away for a reader", async ({ page }) => {
    test.setTimeout(90_000);
    const { projectId, day } = await openNewDay(page, "Bar place");
    await saveEntry(page, projectId, day);
    await page.reload();
    await expect(description(page)).toBeEditable({ timeout: 15_000 });
    await expect(bar(page)).toBeVisible();
    const window_ = page.viewportSize()!;

    // at the top of a long page the bar is still on the screen, at its foot
    await page.evaluate(() => window.scrollTo(0, 0));
    const stuck = (await bar(page).boundingBox())!;
    expect(stuck.y + stuck.height, "the bar ends at the foot of the window").toBeGreaterThan(window_.height - 2);
    expect(stuck.y + stuck.height).toBeLessThanOrEqual(window_.height + 0.5);

    // at the end of the page it lies after the last card, covering nothing
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    const atEnd = (await bar(page).boundingBox())!;
    const cards = await page.evaluate(() => Math.max(...Array.from(document.querySelectorAll("main .rounded-lg")).map((el) => el.getBoundingClientRect().bottom)));
    expect(cards, "the last card ends above the bar").toBeLessThanOrEqual(atEnd.y + 0.5);

    // the bar belongs to the person who writes; it is a region with a name, and it is the last thing on the page for the keyboard
    await expect(bar(page)).toHaveCount(1);
  });
});

test.describe("the detail fields", () => {
  test("are one line high while they are empty, grow with what is written, stop at a height and scroll, and shrink back", async ({ page }) => {
    test.setTimeout(90_000);
    await openNewDay(page, "Grow");
    const materials = page.locator('textarea[name="detail-materials"]');
    const machinery = page.locator('textarea[name="detail-machinery"]');
    const height = async (l: Locator) => (await l.boundingBox())!.height;
    // where a field is on the page, whatever the window has scrolled to
    const top = (l: Locator) => l.evaluate((el) => el.getBoundingClientRect().top + window.scrollY);

    // compact: the nine are one line high (a finger's 44 px), the work description keeps its rows
    for (const key of ["materials", "machinery", "testsAndChecks", "safetyNotes", "dustMeasures", "accessibilityMeasures", "defects", "workStateChanges", "otherNotes"]) {
      const h = await height(page.locator(`textarea[name="detail-${key}"]`));
      expect(h, `${key} is compact`).toBeGreaterThanOrEqual(44);
      expect(h, `${key} is compact`).toBeLessThanOrEqual(48);
    }
    expect(await height(description(page))).toBeGreaterThan(80);

    // focusing it does not move anything; the text makes it grow
    const compact = await height(materials);
    const below = await top(machinery);
    await materials.focus();
    expect(await height(materials)).toBe(compact);
    expect(await top(machinery)).toBe(below);
    await materials.fill("jeden\ndva\ntři\nčtyři\npět\nšest");
    expect(await height(materials)).toBeGreaterThan(130);
    expect(await top(machinery), "what is below moved down by the lines that were added").toBeGreaterThan(below + 80);

    // a very long text stops at a height, and the field scrolls inside itself
    await materials.fill(Array.from({ length: 80 }, (_, i) => `řádek ${i + 1}`).join("\n"));
    const capped = await height(materials);
    expect(capped).toBeGreaterThan(200);
    expect(capped).toBeLessThanOrEqual(272);
    expect(await materials.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);

    // emptied, it is one line again
    await materials.fill("");
    expect(await height(materials)).toBe(compact);
  });

  test("do not jump while they are written in: what is below only moves down, line by line, and the label, the name and the hint are as they were", async ({ page }) => {
    test.setTimeout(90_000);
    await openNewDay(page, "Grow steady");
    const defects = page.locator('textarea[name="detail-defects"]');
    const next = page.locator('textarea[name="detail-workStateChanges"]');
    // the label, the name and the hint of the field are what they were
    await expect(page.getByLabel("Závady a jejich odstranění")).toHaveAttribute("name", "detail-defects");
    await expect(defects).toHaveAttribute("placeholder", "Zjištěné závady a způsob jejich odstranění");

    await defects.focus();
    const start = await next.evaluate((el) => el.getBoundingClientRect().top + window.scrollY);
    await page.evaluate(() => {
      const target = document.querySelector('textarea[name="detail-workStateChanges"]')!;
      const w = window as unknown as { __ys: number[]; __run: boolean };
      w.__ys = [];
      w.__run = true;
      const sample = () => {
        w.__ys.push(target.getBoundingClientRect().top + window.scrollY);
        if (w.__run) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    // 160 characters wrap onto a second and a third line
    await defects.pressSequentially(
      "Trhlina v omítce u okna ve druhém podlaží, opravena sanační maltou, další závady nebyly zjištěny, zbytek stěny je v pořádku a bez vad. ".repeat(2),
      {
        delay: 5,
      },
    );
    const ys = await page.evaluate(() => {
      const w = window as unknown as { __ys: number[]; __run: boolean };
      w.__run = false;
      return w.__ys;
    });
    expect(ys.length).toBeGreaterThan(10);
    for (let i = 1; i < ys.length; i++) expect(ys[i], `frame ${i}: the field below never moves up while the text above only grows`).toBeGreaterThanOrEqual(ys[i - 1] - 0.5);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(start - 0.5);
    const grown = await next.evaluate((el) => el.getBoundingClientRect().top + window.scrollY);
    expect(grown - start, "it moved down by the lines that were added").toBeGreaterThan(20);
    expect(grown - start).toBeLessThan(140);
  });

  test("a saved entry opens with its text shown whole", async ({ page }) => {
    test.setTimeout(90_000);
    await signInAdmin(page);
    const { projectId, projectPath } = await makeProject(page, "Grow saved");
    const day = pragueDay(0);
    await saveEntry(page, projectId, day, { details: { materials: Array.from({ length: 6 }, (_, i) => `Beton ${i + 1}`).join("\n"), machinery: "Čerpadlo" } });
    await page.goto(entryUrl(projectPath, day));
    const materials = page.locator('textarea[name="detail-materials"]');
    await expect(materials).toHaveValue(/Beton 6/, { timeout: 15_000 });
    expect((await materials.boundingBox())!.height, "six lines of text are all in view").toBeGreaterThan(130);
    expect(await materials.evaluate((el) => el.scrollHeight <= el.clientHeight)).toBe(true);
    expect((await page.locator('textarea[name="detail-machinery"]').boundingBox())!.height, "a line of text is one line").toBeLessThanOrEqual(48);
    expect((await page.locator('textarea[name="detail-defects"]').boundingBox())!.height, "an empty field is compact").toBeLessThanOrEqual(48);
  });
});

/** The photos of one test: every upload request is held until the test lets it go, and told apart by the file name in its body. */
class HeldUploads {
  readonly all: { name: string; route: Route; released: boolean }[] = [];
  constructor(private readonly page: Page) {}
  static nameOf(request: Request): string {
    return /filename="([^"]+)"/.exec(request.postDataBuffer()?.toString("latin1") ?? "")?.[1] ?? "?";
  }
  async start() {
    await this.page.route("**/api/photos/upload", (route) => {
      this.all.push({ name: HeldUploads.nameOf(route.request()), route, released: false });
    });
  }
  get inFlight() {
    return this.all.filter((u) => !u.released).map((u) => u.name);
  }
  private find(name: string) {
    const held = this.all.find((u) => u.name === name && !u.released);
    expect(held, `an upload of ${name} is held`).toBeTruthy();
    return held!;
  }
  /** Lets the upload through to the server. */
  async pass(name: string) {
    const held = this.find(name);
    held.released = true;
    await held.route.continue();
  }
  /** Answers the upload without the server. */
  async answer(name: string, status: number, body: unknown, headers: Record<string, string> = {}) {
    const held = this.find(name);
    held.released = true;
    await held.route.fulfill({ status, contentType: "application/json", headers, body: JSON.stringify(body) });
  }
  async drop(name: string) {
    const held = this.find(name);
    held.released = true;
    await held.route.abort("connectionreset");
  }
  /**
   * The server takes the photo (it is stored), and the page is answered like a gateway that timed out: nothing says the photo is there. The photo is
   * stored by a request of the test itself (`route.fetch` replays the page's request without its `Sec-Fetch-Site`, which the cross-site check refuses).
   */
  async gatewayTimeout(name: string, entry: { projectId: string; day: string }, status = 504) {
    const held = this.find(name);
    held.released = true;
    const stored = await this.page.request.post("/api/photos/upload", {
      multipart: { reportId: entry.day, projectId: entry.projectId, photo: { name, mimeType: "image/jpeg", buffer: JPEG } },
    });
    expect(stored.ok(), `the photo is stored: ${stored.status()} ${await stored.text()}`).toBeTruthy();
    await held.route.fulfill({ status, contentType: "text/html", body: "<html>Gateway Timeout</html>" });
  }
}

const photoFile = (name: string) => ({ name, mimeType: "image/jpeg", buffer: JPEG });

async function openSavedEntry(page: Page, label: string) {
  await signInAdmin(page);
  const { projectId, projectPath } = await makeProject(page, label);
  const day = pragueDay(0);
  await saveEntry(page, projectId, day);
  await page.goto(entryUrl(projectPath, day));
  await expect(page.locator("input#photo-files")).toBeEnabled({ timeout: 15_000 });
  return { projectId, projectPath, day };
}

test.describe("several photos at once", () => {
  test("go one by one, two requests at a time, each with a progress bar, and the page says how many have arrived", async ({ page }) => {
    test.setTimeout(120_000);
    await openSavedEntry(page, "Photos");
    const held = new HeldUploads(page);
    await held.start();
    const input = page.locator("input#photo-files");
    await expect(input).toHaveAttribute("multiple", "");

    await input.setInputFiles([photoFile("a.jpg"), photoFile("b.jpg"), photoFile("c.jpg")]);
    await expect(page.getByText("Vybráno: 3 fotky")).toBeVisible();
    await page.getByRole("button", { name: "Nahrát fotky" }).click();

    // two are on their way, the third waits its turn; every one has a bar with a name
    await expect.poll(() => held.inFlight).toEqual(["a.jpg", "b.jpg"]);
    await page.waitForTimeout(400);
    expect(held.inFlight, "never more than two at a time").toEqual(["a.jpg", "b.jpg"]);
    const list = page.getByRole("list", { name: "Nahrávané fotky" });
    await expect(list.getByRole("listitem")).toHaveCount(3);
    await expect(list.getByRole("progressbar")).toHaveCount(3);
    await expect(list.getByRole("progressbar", { name: /a\.jpg/ })).toHaveAttribute("aria-valuenow", "0");
    await expect(list.getByRole("listitem").nth(2)).toContainText("Čeká na řadu");
    const status = page.getByRole("status").filter({ hasText: /Nahráno|Vybráno/ });

    await held.pass("a.jpg");
    await expect(status).toHaveText("Nahráno 1 z 3");
    await expect.poll(() => held.inFlight).toEqual(["b.jpg", "c.jpg"]);
    await held.pass("c.jpg");
    await held.pass("b.jpg");
    await expect(status).toHaveText("Nahráno 3 z 3", { timeout: 15_000 });
    await expect(page.locator('img[alt^="Fotka"]')).toHaveCount(3);
    await expect(list.getByRole("listitem")).toHaveCount(0);

    // the photos are on the entry: a reload shows the same three
    await page.reload();
    await expect(page.locator('img[alt^="Fotka"]')).toHaveCount(3, { timeout: 15_000 });
  });

  test("wait for a busy server (429 with Retry-After) and send the same photo again; a photo the server refuses, or a lost connection, never holds the others back", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await openSavedEntry(page, "Photos failing");
    const held = new HeldUploads(page);
    await held.start();
    await page.locator("input#photo-files").setInputFiles([photoFile("busy.jpg"), photoFile("bad.jpg"), photoFile("lost.jpg"), photoFile("good.jpg")]);
    await page.getByRole("button", { name: "Nahrát fotky" }).click();
    const list = page.getByRole("list", { name: "Nahrávané fotky" });
    const status = page.getByRole("status").filter({ hasText: /Nahráno|Vybráno/ });

    await expect.poll(() => held.inFlight).toEqual(["busy.jpg", "bad.jpg"]);
    // the server is busy with another photo of this person: it says when to come back; the photo waits and is sent again
    await held.answer("busy.jpg", 429, { error: "Právě se nahrává další vaše fotografie. Počkejte, až skončí, a zkuste to znovu." }, { "Retry-After": "1" });
    await expect(list.getByRole("listitem").filter({ hasText: "busy.jpg" })).toContainText(/zaneprázdněný|další pokus za 1 s/);
    // the server refuses a photo: it says so and does not offer to send it again
    await held.answer("bad.jpg", 400, { error: "Soubor není platný obrázek" });
    await expect(page.getByRole("alert").filter({ hasText: "Soubor není platný obrázek" })).toBeVisible();
    // the next ones go on while the first waits
    await expect.poll(() => held.inFlight).toEqual(expect.arrayContaining(["lost.jpg"]));
    await held.drop("lost.jpg");
    await expect.poll(() => held.inFlight).toEqual(expect.arrayContaining(["good.jpg"]));
    await held.pass("good.jpg");
    await expect.poll(() => held.inFlight).toEqual(["busy.jpg"]); // sent again after its second
    await held.pass("busy.jpg");

    await expect(status).toHaveText("Nahráno 2 z 4 (nepodařilo se 2)", { timeout: 15_000 });
    await expect(page.locator('img[alt^="Fotka"]')).toHaveCount(2);
    const alerts = page.getByRole("alert");
    await expect(alerts.filter({ hasText: "Soubor není platný obrázek" })).toBeVisible();
    // the connection failed before the photo had gone out: nothing arrived, and the row says so plainly (no "may have arrived")
    const lostRow = list.getByRole("listitem").filter({ hasText: "lost.jpg" });
    await expect(lostRow).toContainText("Nenahráno");
    await expect(lostRow.getByRole("alert")).toContainText("Spojení se přerušilo, než se fotka odeslala. Nic se nenahrálo");
    await expect(lostRow).not.toContainText("Možná nahráno");

    // only that one may be sent again, from its own row (the files are not chosen again), and that is the person's decision; it arrives
    await expect(page.getByRole("button", { name: /Zkusit znovu nahrát/ })).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Zkusit znovu všechny" })).toHaveCount(0);
    await lostRow.getByRole("button", { name: "Zkusit znovu nahrát lost.jpg" }).click();
    await expect.poll(() => held.inFlight).toEqual(["lost.jpg"]);
    await held.pass("lost.jpg");
    await expect(status).toHaveText("Nahráno 3 z 4 (nepodařilo se 1)", { timeout: 15_000 });
    await expect(page.getByRole("button", { name: /Zkusit znovu/ })).toHaveCount(0);
    await expect(page.locator('img[alt^="Fotka"]')).toHaveCount(3);

    // the one the server refused is put away by the person (nothing is deleted anywhere); then the list can be hidden
    await expect(list.getByRole("listitem")).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Skrýt přehled" })).toHaveCount(0);
    await page.getByRole("button", { name: "Zahodit bad.jpg" }).click();
    await expect(list).toHaveCount(0);
    await expect(status).toHaveText("Nahráno 3 z 3");
    await page.getByRole("button", { name: "Skrýt přehled" }).click();
    await expect(status).toHaveCount(0); // the summary is empty: there is nothing to say
  });

  test("a file that is too big or not an image is refused in Czech before anything is sent", async ({ page }) => {
    test.setTimeout(90_000);
    await openSavedEntry(page, "Photos refused");
    let sent = 0;
    await page.route("**/api/photos/upload", (route) => {
      sent += 1;
      return route.continue();
    });
    const upload = page.getByRole("button", { name: "Nahrát fotky" });
    await page.locator("input#photo-files").setInputFiles([
      { name: "velka.jpg", mimeType: "image/jpeg", buffer: Buffer.alloc(5 * 1024 * 1024 + 1) },
      { name: "plan.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.7") },
    ]);
    const alert = page.getByRole("alert");
    await expect(alert).toContainText("Soubor „velka.jpg“ je větší než 5 MB.");
    await expect(alert).toContainText("Soubor „plan.pdf“ není obrázek.");
    await expect(upload).toBeDisabled();

    // a choice with one good file in it: the good one goes, the others are still said
    await page.locator("input#photo-files").setInputFiles([photoFile("dobra.jpg"), { name: "plan.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.7") }]);
    await expect(page.getByText("Vybráno: 1 fotka")).toBeVisible();
    await expect(alert).toContainText("Soubor „plan.pdf“ není obrázek.");
    expect(sent).toBe(0);
    await upload.click();
    await expect(page.getByRole("status").filter({ hasText: "Nahráno 1 z 1" })).toBeVisible({ timeout: 15_000 });
    expect(sent).toBe(1);
  });

  test("count as unsaved work while they are on their way, and only then", async ({ page }) => {
    test.setTimeout(90_000);
    const { projectPath } = await openSavedEntry(page, "Photos leave");
    const held = new HeldUploads(page);
    await held.start();
    await page.locator("input#photo-files").setInputFiles([photoFile("a.jpg")]);
    await page.getByRole("button", { name: "Nahrát fotky" }).click();
    await expect.poll(() => held.inFlight).toEqual(["a.jpg"]);

    await page.getByRole("link", { name: /Zpět na seznam záznamů/ }).click();
    const ask = page.getByRole("dialog", { name: "Neuložené změny" });
    await expect(ask).toContainText("Fotky se ještě nahrávají");
    await ask.getByRole("button", { name: "Zůstat" }).click();
    await expect(page).toHaveURL(new RegExp(`${projectPath}/reports/`));

    // when they have arrived the page asks nothing
    await held.pass("a.jpg");
    await expect(page.getByRole("status").filter({ hasText: "Nahráno 1 z 1" })).toBeVisible({ timeout: 15_000 });
    await page.getByRole("link", { name: /Zpět na seznam záznamů/ }).click();
    await expect(page).toHaveURL(new RegExp(`${projectPath}\\?tab=reports$`));
  });

  test("an ended session signs in again in place, and the photo waits to be sent again", async ({ page }) => {
    test.setTimeout(90_000);
    await openSavedEntry(page, "Photos session");
    const held = new HeldUploads(page);
    await held.start();
    await page.locator("input#photo-files").setInputFiles([photoFile("a.jpg"), photoFile("b.jpg"), photoFile("c.jpg")]);
    await page.getByRole("button", { name: "Nahrát fotky" }).click();
    await expect.poll(() => held.inFlight).toEqual(["a.jpg", "b.jpg"]);

    await held.answer("a.jpg", 401, { error: "Nepřihlášen" });
    const dialog = page.getByRole("dialog", { name: /přihlášení vypršelo/i });
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    await held.answer("b.jpg", 401, { error: "Nepřihlášen" });
    // nothing more is sent while the session is over: c.jpg waits and is told so
    await page.waitForTimeout(300);
    expect(held.all.map((u) => u.name)).toEqual(["a.jpg", "b.jpg"]);
    await dialog.getByLabel("Heslo").fill(ADMIN_PASSWORD);
    await dialog.getByRole("button", { name: /přihlásit se/i }).click();
    await expect(dialog).toBeHidden({ timeout: 15_000 });
    await expect(page.getByRole("alert").filter({ hasText: /Přihlášení vypršelo/ })).toHaveCount(3);

    await page.getByRole("button", { name: "Zkusit znovu všechny" }).click();
    await expect.poll(() => held.inFlight).toEqual(["a.jpg", "b.jpg"]);
    await held.pass("a.jpg");
    await held.pass("b.jpg");
    await expect.poll(() => held.inFlight).toEqual(["c.jpg"]);
    await held.pass("c.jpg");
    await expect(page.getByRole("status").filter({ hasText: "Nahráno 3 z 3" })).toBeVisible({ timeout: 15_000 });
  });

  test("the entry cannot be signed while a photo that failed is on the list: the person sends it again or puts it away, and then signs", async ({ page }) => {
    test.setTimeout(90_000);
    await openSavedEntry(page, "Photos sign");
    const held = new HeldUploads(page);
    await held.start();
    const sign = page.getByRole("region", { name: "Akce záznamu" }).getByRole("button", { name: /podepsat a uzamknout/i });
    await expect(sign).toBeEnabled();

    await page.locator("input#photo-files").setInputFiles([photoFile("a.jpg")]);
    await page.getByRole("button", { name: "Nahrát fotky" }).click();
    // while it is on its way: off, and why
    await expect.poll(() => held.inFlight).toEqual(["a.jpg"]);
    await expect(sign).toBeDisabled();
    await expect(sign).toHaveAttribute("aria-disabled", "true");
    await expect(page.locator("#entry-sign-hint")).toContainText("Počkejte, až se nahrají všechny fotky");
    await held.drop("a.jpg");

    // failed and still on the list: off, a visible line says what to do, the button is described by it, and pressing it says it too
    const line = page.locator("#photos-failed-line");
    await expect(line).toHaveText("1 fotka se nenahrála: nahrajte ji znovu, nebo ji zahoďte.");
    await expect(sign).toBeDisabled();
    await expect(sign).toHaveAttribute("aria-describedby", "entry-sign-hint");
    await expect(page.locator("#entry-sign-hint")).toContainText("1 fotka se nenahrála");
    await sign.click({ force: true }); // it is off for the keyboard and a screen reader too, but it is there to be pressed, and says why
    await expect(page.getByRole("alert").filter({ hasText: "Záznam se podepíše až potom" })).toBeVisible();
    await expect(page.getByRole("dialog", { name: /podepsat a uzamknout záznam/i })).toHaveCount(0);

    // put away on purpose ("Zahodit" takes it off the list; nothing is deleted on the server): the signing is on again and opens its dialog
    await page.getByRole("button", { name: "Zahodit a.jpg" }).click();
    await expect(line).toHaveCount(0);
    await expect(sign).toBeEnabled();
    await sign.click();
    const dialog = page.getByRole("dialog", { name: /podepsat a uzamknout záznam/i });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Zrušit" }).click();
    await expect(dialog).toBeHidden();
  });

  test("a gateway that does not answer after the server took the photo: only that photo may have arrived, the photos of the entry are read again and it is there to see", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const { projectId, day } = await openSavedEntry(page, "Photos gateway");
    const entryReads: string[] = [];
    page.on("request", (r) => {
      if (r.method() === "GET" && r.url().endsWith(`/api/projects/${projectId}/reports/${day}`)) entryReads.push(r.url());
    });
    const held = new HeldUploads(page);
    await held.start();
    await page.locator("input#photo-files").setInputFiles([photoFile("sent.jpg"), photoFile("never.jpg"), photoFile("after.jpg")]);
    await page.getByRole("button", { name: "Nahrát fotky" }).click();
    await expect.poll(() => held.inFlight).toEqual(["sent.jpg", "never.jpg"]);

    // a photo that never went out: nothing arrived, so the page has nothing to look for
    await held.drop("never.jpg");
    const list = page.getByRole("list", { name: "Nahrávané fotky" });
    await expect(list.getByRole("listitem").filter({ hasText: "never.jpg" })).toContainText("Nenahráno");
    expect(entryReads, "the entry was not read again for a photo that never went").toHaveLength(0);
    expect(await entryPhotos(page, projectId, day)).toBe(0);

    // a photo that the server took and the gateway did not answer for: the server has it, the page says "Možná nahráno", and shows it
    await held.gatewayTimeout("sent.jpg", { projectId, day });
    const sentRow = list.getByRole("listitem").filter({ hasText: "sent.jpg" });
    await expect(sentRow).toContainText("Možná nahráno");
    await expect(sentRow.getByRole("alert")).toContainText("Server neodpověděl, jak má. Fotka se mohla uložit");
    await expect(page.locator('img[alt^="Fotka"]'), "the photo that did arrive is in the photographs of the entry, so the person can see it is there").toHaveCount(1, {
      timeout: 15_000,
    });
    expect(entryReads.length).toBeGreaterThan(0);
    expect(await entryPhotos(page, projectId, day)).toBe(1);

    // the one that was not sent is not sent again by itself, and the one that may have arrived is not either
    await expect.poll(() => held.inFlight).toEqual(["after.jpg"]);
    await held.pass("after.jpg");
    await page.waitForTimeout(400);
    expect(held.all.filter((u) => u.name === "sent.jpg")).toHaveLength(1);
    expect(held.all.filter((u) => u.name === "never.jpg")).toHaveLength(1);

    // both can be sent again from their own rows; the person decides (the one that may have arrived is put away instead)
    await page.getByRole("button", { name: "Zahodit sent.jpg" }).click();
    await list.getByRole("listitem").filter({ hasText: "never.jpg" }).getByRole("button", { name: "Zkusit znovu nahrát never.jpg" }).click();
    await expect.poll(() => held.inFlight).toEqual(["never.jpg"]);
    await held.pass("never.jpg");
    await expect(page.locator('img[alt^="Fotka"]')).toHaveCount(3, { timeout: 15_000 });
    expect(await entryPhotos(page, projectId, day)).toBe(3);
  });

  test("a 408 (the server took nothing) is offered again and not sent by itself; two failed photos are sent together with one button", async ({ page }) => {
    test.setTimeout(90_000);
    await openSavedEntry(page, "Photos 408");
    const held = new HeldUploads(page);
    await held.start();
    await page.locator("input#photo-files").setInputFiles([photoFile("a.jpg"), photoFile("b.jpg")]);
    await page.getByRole("button", { name: "Nahrát fotky" }).click();
    await expect.poll(() => held.inFlight).toEqual(["a.jpg", "b.jpg"]);
    const slow = { error: "Nahrávání fotografie trvalo příliš dlouho, zkuste to znovu" };
    await held.answer("a.jpg", 408, slow);
    await held.answer("b.jpg", 408, slow);

    const list = page.getByRole("list", { name: "Nahrávané fotky" });
    await expect(list.getByRole("listitem").filter({ hasText: "a.jpg" }).getByRole("alert")).toHaveText(slow.error);
    await page.waitForTimeout(500);
    expect(held.all, "a photo that waited too long is not sent again by itself").toHaveLength(2);
    await expect(page.getByRole("button", { name: /Zkusit znovu nahrát/ })).toHaveCount(2);

    // one button for all of them
    await page.getByRole("button", { name: "Zkusit znovu všechny" }).click();
    await expect.poll(() => held.inFlight).toEqual(["a.jpg", "b.jpg"]);
    await held.pass("a.jpg");
    await held.pass("b.jpg");
    await expect(page.getByRole("status").filter({ hasText: "Nahráno 2 z 2" })).toBeVisible({ timeout: 15_000 });
  });

  test("says the server's words once when the limit of uploads is reached, not twice", async ({ page }) => {
    test.setTimeout(90_000);
    await openSavedEntry(page, "Photos limit");
    const held = new HeldUploads(page);
    await held.start();
    await page.locator("input#photo-files").setInputFiles([photoFile("a.jpg")]);
    await page.getByRole("button", { name: "Nahrát fotky" }).click();
    await expect.poll(() => held.inFlight).toEqual(["a.jpg"]);
    // what RateLimiter says for the 61st upload in five minutes: its Retry-After is 4 minutes and the message already says so
    await held.answer("a.jpg", 429, { error: "Příliš mnoho nahrávání fotografií. Zkuste to znovu za 4 minuty." }, { "Retry-After": "240" });
    const row = page.getByRole("list", { name: "Nahrávané fotky" }).getByRole("listitem").filter({ hasText: "a.jpg" });
    await expect(row.getByRole("alert")).toHaveText("Příliš mnoho nahrávání fotografií. Zkuste to znovu za 4 minuty.");
    await expect(page.getByRole("button", { name: "Zkusit znovu nahrát a.jpg" })).toBeVisible();
  });
});

/** How many photos the server has on the entry of [day] (not what the page shows). */
async function entryPhotos(page: Page, projectId: string, day: string): Promise<number> {
  const res = await page.request.get(`/api/projects/${projectId}/reports/${day}`);
  expect(res.ok()).toBeTruthy();
  return ((await res.json()) as { photos: unknown[] }).photos.length;
}
