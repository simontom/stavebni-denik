import { expect, test, type Locator, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { makeProject, pragueDay, saveEntry, signInAdmin } from "./helpers";

/**
 * The entry on a phone (backlog B5; `playwright.config.ts`: 360 x 780 upright and 780 x 360 sideways, both with a touch screen): the one
 * bar of actions at the foot of the screen (above the safe area, covering nothing, out of the way while a keyboard is open), the chips,
 * the compact fields and the list of photos that are on their way, all of them a thumb high and none of them wider than the screen.
 * The behaviour itself is in `entry-ergonomics.spec.ts`.
 */

const MIN_TARGET = 44;
const JPEG = fs.readFileSync(path.resolve(__dirname, "fixtures/dummy-photo.jpg"));
const bar = (page: Page) => page.getByRole("region", { name: "Akce záznamu" });
const description = (page: Page) => page.locator('textarea[name="workDescription"]');

async function openSavedEntry(page: Page, label: string) {
  await signInAdmin(page);
  const { projectId, projectPath } = await makeProject(page, label);
  const day = pragueDay(0);
  await saveEntry(page, projectId, day, { details: { materials: "Beton C25/30" }, weather: { condition: "zataženo" } });
  await page.goto(`${projectPath}/reports/${day}`);
  await expect(description(page)).toBeEditable({ timeout: 15_000 });
  await expect(bar(page)).toBeVisible();
  return { projectId, projectPath, day };
}

async function expectNoSidewaysScroll(page: Page, what: string) {
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
  expect.soft(scrollWidth, `${what}: the page is ${scrollWidth}px wide on a ${innerWidth}px screen`).toBeLessThanOrEqual(innerWidth);
}

/** Every visible button and one-line field is a thumb high, every visible field has 16 px text. */
async function expectTouchReady(page: Page, what: string) {
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
  const fonts = await page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>("input:not([type=checkbox]):not([type=radio]):not([type=file]):not([type=hidden]), textarea, select"))
      .filter((el) => el.getClientRects().length > 0)
      .filter((el) => parseFloat(getComputedStyle(el).fontSize) < 16)
      .map((el) => el.getAttribute("name") ?? el.id),
  );
  expect.soft(fonts, `${what}: fields with text under 16px`).toEqual([]);
}

/** A control is whole on the screen and at least a thumb high. */
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

test.describe("the entry on a phone", () => {
  test("the bar of actions is at the foot of the screen, a thumb high, whole, short, and the page ends above it", async ({ page }) => {
    test.setTimeout(90_000);
    await openSavedEntry(page, "Phone bar");
    const screen = page.viewportSize()!;
    await page.evaluate(() => window.scrollTo(0, 0));

    // at the top of a long page it is still on the screen, at its foot
    const box = (await bar(page).boundingBox())!;
    expect(box.y + box.height, "the bar ends at the foot of the screen").toBeGreaterThan(screen.height - 2);
    expect(box.y + box.height).toBeLessThanOrEqual(screen.height + 0.5);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(screen.width + 0.5);
    expect(box.height, "a bar that takes more than two fifths of the screen leaves no room for the entry").toBeLessThanOrEqual(screen.height * 0.4);

    // its buttons: the signing, the PDF and the save of a saved entry, each whole on the screen and a thumb high
    for (const name of [/podepsat a uzamknout/i, "Stáhnout PDF", "Uložit změny"]) {
      await expectReachable(page, bar(page).getByRole("button", { name }), `the bar's button ${String(name)}`);
    }
    // above the safe area: at least the usual padding, and more where the phone has a notch or a home indicator (env(safe-area-inset-bottom))
    const padding = await bar(page).evaluate((el) => parseFloat(getComputedStyle(el).paddingBottom));
    expect(padding).toBeGreaterThanOrEqual(12);
    expect(await bar(page).evaluate((el) => el.scrollWidth - el.clientWidth), "the bar does not scroll sideways").toBeLessThanOrEqual(1);
    await expectNoSidewaysScroll(page, "an entry with the bar");

    // at the end of the page the bar follows the last card and covers nothing
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    const atEnd = (await bar(page).boundingBox())!;
    const lastCard = await page.evaluate(() => Math.max(...Array.from(document.querySelectorAll("main .rounded-lg")).map((el) => el.getBoundingClientRect().bottom)));
    expect(lastCard, "the last card ends above the bar").toBeLessThanOrEqual(atEnd.y + 0.5);
  });

  test("the bar is out of the way while a keyboard is open (the visual viewport is shortened), and not for a zoom or a small change", async ({ page }) => {
    test.setTimeout(90_000);
    await openSavedEntry(page, "Phone keyboard");
    const setViewport = (height: number | null, scale = 1) =>
      page.evaluate(
        ([h, s]) => {
          const vv = window.visualViewport!;
          if (h === null) {
            Reflect.deleteProperty(vv, "height");
            Reflect.deleteProperty(vv, "scale");
          } else {
            Object.defineProperty(vv, "height", { configurable: true, get: () => h });
            Object.defineProperty(vv, "scale", { configurable: true, get: () => s });
          }
          vv.dispatchEvent(new Event("resize"));
        },
        [height, scale] as const,
      );
    const full = await page.evaluate(() => window.innerHeight);

    // the keyboard: half of the height is gone
    await setViewport(Math.round(full * 0.5));
    await expect(bar(page)).toBeHidden();
    // and gone: the visual viewport is the page again
    await setViewport(null);
    await expect(bar(page)).toBeVisible();
    // the address bar of the browser collapses (60 to 80 px): that is not a keyboard
    await setViewport(full - 70);
    await expect(bar(page)).toBeVisible();
    // a pinch zoom shortens the visual viewport too, and is not a keyboard
    await setViewport(Math.round(full / 2), 2);
    await expect(bar(page)).toBeVisible();
    await setViewport(null);
    await expect(bar(page)).toBeVisible();
  });

  test("a control that is reached with the keyboard is never under the bar", async ({ page }) => {
    test.setTimeout(90_000);
    await openSavedEntry(page, "Phone focus");
    await page.evaluate(() => window.scrollTo(0, 0));
    await description(page).focus();
    const hidden: string[] = [];
    let reachedBar = false;
    // Tab through the page to the bar. A control may be partly under the bar, but never so far that its first 40 px (or all of it, when it is
    // lower) are not on the screen: the person has to see where the focus is.
    for (let i = 0; i < 80 && !reachedBar; i++) {
      await page.keyboard.press("Tab");
      const state = await page.evaluate(() => {
        const active = document.activeElement as HTMLElement | null;
        const region = document.querySelector<HTMLElement>('[aria-label="Akce záznamu"]');
        if (!active || !region || active === document.body) return { bar: false, covered: null };
        if (region.contains(active)) return { bar: true, covered: null };
        const a = active.getBoundingClientRect();
        const b = region.getBoundingClientRect();
        const shown = Math.min(a.bottom, b.top, window.innerHeight) - Math.max(a.top, 0);
        const wanted = Math.min(a.height, 40);
        return { bar: false, covered: shown < wanted - 0.5 ? `${active.getAttribute("name") ?? active.id ?? active.tagName} (${Math.round(shown)}px of it above the bar)` : null };
      });
      if (state.covered) hidden.push(state.covered);
      reachedBar = state.bar;
    }
    expect(reachedBar, "Tab reaches the bar after the last control of the page").toBe(true);
    expect(hidden, "controls focused with Tab and left under the bar").toEqual([]);
  });

  test("the chips, the compact fields, the total and the day links are a thumb high and fit the screen", async ({ page }) => {
    test.setTimeout(90_000);
    const { projectPath, day } = await openSavedEntry(page, "Phone fields");
    const chips = page.getByRole("group", { name: "Rychlý výběr počasí" });
    await expect(chips).toBeVisible();
    for (const name of ["jasno", "déšť", "silný vítr", "mráz"]) await expectReachable(page, chips.getByRole("button", { name, exact: true }), `the chip ${name}`);
    await expectReachable(page, page.getByRole("navigation", { name: "Dny záznamů" }).getByRole("link", { name: /Předchozí den/ }), "the link to the previous day");
    // the empty detail fields are one line, which is a thumb high; the one with text is as tall as its text
    for (const key of ["machinery", "testsAndChecks", "safetyNotes", "dustMeasures", "accessibilityMeasures", "defects", "workStateChanges", "otherNotes"]) {
      const h = (await page.locator(`textarea[name="detail-${key}"]`).boundingBox())!.height;
      expect(h, `the empty field ${key} is one line, which is a thumb high (${Math.round(h)}px)`).toBeGreaterThanOrEqual(MIN_TARGET);
      expect(h, `the empty field ${key} is one line, even with an example that is longer than the line (${Math.round(h)}px)`).toBeLessThanOrEqual(MIN_TARGET + 4);
    }
    await expect(page.locator("#worker-total")).toBeVisible();
    await expectNoSidewaysScroll(page, "the entry form");
    await expectTouchReady(page, "the entry form");

    // a chip pressed with a finger works like a click, and the form is not wider for the longest text
    await page.locator('input[name="weatherCondition"]').fill("");
    await chips.getByRole("button", { name: "silný vítr", exact: true }).tap();
    await expect(page.locator('input[name="weatherCondition"]')).toHaveValue("silný vítr");
    await page.locator('textarea[name="detail-materials"]').fill(`${"x".repeat(120)}\n${"Beton ".repeat(40)}`);
    await expectNoSidewaysScroll(page, "a detail field with a long text");
    // the next day link is not offered on today, and the previous one leads to yesterday
    await expect(page.getByRole("navigation", { name: "Dny záznamů" }).getByRole("link", { name: /Následující den/ })).toHaveCount(0);
    await expect(page.getByRole("navigation", { name: "Dny záznamů" }).getByRole("link", { name: /Předchozí den/ })).toHaveAttribute(
      "href",
      `${projectPath}/reports/${pragueDay(-1)}`,
    );
    expect(day).toBe(pragueDay(0));
  });

  test("the photos that are on their way fit the screen, with a bar for each and the buttons a thumb high", async ({ page }) => {
    test.setTimeout(90_000);
    await openSavedEntry(page, "Phone photos");
    const held: { name: string; release: (how: "drop" | "pass") => Promise<void> }[] = [];
    await page.route("**/api/photos/upload", (route) => {
      const name = /filename="([^"]+)"/.exec(route.request().postDataBuffer()?.toString("latin1") ?? "")?.[1] ?? "?";
      held.push({ name, release: async (how) => (how === "drop" ? route.abort("connectionreset") : route.continue()) });
    });
    const files = ["strop-prvni-patro-sever.jpg", "b.jpg", "c.jpg"].map((name) => ({ name, mimeType: "image/jpeg", buffer: JPEG }));
    await page.locator("input#photo-files").setInputFiles(files);
    await expectReachable(page, page.getByRole("button", { name: "Nahrát fotky" }), "the button that uploads the photos");
    await page.getByRole("button", { name: "Nahrát fotky" }).click();
    await expect.poll(() => held.length).toBe(2);

    const list = page.getByRole("list", { name: "Nahrávané fotky" });
    await expect(list.getByRole("progressbar")).toHaveCount(3);
    for (const bar_ of await list.getByRole("progressbar").all()) {
      const box = (await bar_.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    }
    await expectNoSidewaysScroll(page, "the photos on their way");

    // a connection lost: the message and the button that sends it again are on the screen
    await held[0].release("drop");
    await held[1].release("pass");
    await expect(page.getByRole("button", { name: "Zkusit znovu" })).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => held.length).toBe(3);
    await held[2].release("pass");
    await expect(page.getByRole("button", { name: "Zkusit znovu" })).toBeEnabled({ timeout: 15_000 });
    await expectReachable(page, page.getByRole("button", { name: "Zkusit znovu" }), "the button that sends the photos again");
    await expectNoSidewaysScroll(page, "the photos that failed");
    await expectTouchReady(page, "the photos that failed");
    // and the failed photo can be put away from its row, a thumb high
    await expectReachable(page, page.getByRole("button", { name: /^Zahodit / }), "the button that discards a photo that failed");
  });

  test("the buttons of the bar stay where they are in every state, so a second tap on the save button cannot land on another one", async ({ page }) => {
    test.setTimeout(90_000);
    await signInAdmin(page);
    const { projectPath } = await makeProject(page, "Phone bar steady");
    await page.goto(`${projectPath}/reports/${pragueDay(0)}`);
    await expect(description(page)).toBeEditable({ timeout: 15_000 });
    const region = bar(page);
    await expect(region).toBeVisible();
    const save = region.getByRole("button", { name: /uložit (záznam|změny)/i });
    const sign = region.getByRole("button", { name: /podepsat a uzamknout/i });
    const slot = region.locator('button[aria-hidden="true"]'); // the place of the PDF while there is nothing to download
    type Box = { x: number; y: number; width: number; height: number };
    const rect = (l: Locator): Promise<Box> =>
      l.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      });
    const boxes = async () => ({ save: await rect(save), sign: await rect(sign), bar: await rect(region), pdf: (await slot.count()) === 1 ? await rect(slot) : null });

    const none = await boxes(); // no entry yet: "Uložit záznam", the signing off
    await description(page).fill("První verze");
    await expect(region.getByText("Neuložené změny")).toBeVisible();
    const dirty = await boxes();
    await save.click();
    await expect(region.getByRole("status")).toHaveText(/Uloženo \d{1,2}:\d{2}/);
    const pdf = region.getByRole("button", { name: "Stáhnout PDF" });
    await expect(pdf).toBeVisible();
    const saved = { ...(await boxes()), pdf: await rect(pdf) }; // saved: the PDF is there, in the place that was kept for it
    await description(page).fill("Druhá verze");
    await expect(region.getByText("Neuložené změny")).toBeVisible();
    const again = await boxes();

    const same = (what: string, a: Box | null, b: Box | null) => {
      expect(a, `${what}: a box`).not.toBeNull();
      expect(b, `${what}: a box`).not.toBeNull();
      for (const key of ["x", "y", "width", "height"] as const) expect(Math.abs(a![key] - b![key]), `${what}: ${key} (${a![key]} against ${b![key]})`).toBeLessThanOrEqual(0.5);
    };
    for (const [state, now] of [
      ["unsaved changes", dirty],
      ["saved", saved],
      ["unsaved changes again", again],
    ] as const) {
      same(`the save button, ${state}`, none.save, now.save);
      same(`the signing, ${state}`, none.sign, now.sign);
      same(`the bar, ${state}`, none.bar, now.bar);
      same(`the PDF, ${state}`, none.pdf, now.pdf);
    }
    // the page keeps its scroll padding at least as large as the bar, whatever the bar's height is
    const padding = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).scrollPaddingBottom));
    expect(padding, "the scroll padding of the page covers the bar").toBeGreaterThanOrEqual(none.bar.height);
  });
});
