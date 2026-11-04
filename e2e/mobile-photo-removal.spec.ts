import { expect, test, type Locator, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { makeProject, pragueDay, saveEntry, signInAdmin } from "./helpers";

/**
 * Removing a photo on a phone (backlog A4; `playwright.config.ts`: 360 x 780 upright and 780 x 360 sideways, both with a touch screen): the
 * button on a photo is a thumb high and whole on the screen, the question fits the screen with its two answers a thumb high and the safe one in
 * focus, and nothing makes the page wider than the screen. The behaviour itself is in `photo-removal.spec.ts`.
 */

const MIN_TARGET = 44;
const JPEG = fs.readFileSync(path.resolve(__dirname, "fixtures/dummy-photo.jpg"));

async function openEntryWithPhotos(page: Page, label: string, photos: number) {
  await signInAdmin(page);
  const { projectId, projectPath } = await makeProject(page, label);
  const day = pragueDay(0);
  await saveEntry(page, projectId, day);
  for (let i = 1; i <= photos; i++) {
    const res = await page.request.post("/api/photos/upload", {
      multipart: { reportId: day, projectId, photo: { name: `foto-${i}.jpg`, mimeType: "image/jpeg", buffer: JPEG } },
    });
    expect(res.ok(), `the photo is stored: ${res.status()} ${await res.text()}`).toBeTruthy();
  }
  await page.goto(`${projectPath}/reports/${day}`);
  await expect(page.locator('img[alt^="Fotka"]')).toHaveCount(photos, { timeout: 15_000 });
}

async function expectNoSidewaysScroll(page: Page, what: string) {
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
  expect.soft(scrollWidth, `${what}: the page is ${scrollWidth}px wide on a ${innerWidth}px screen`).toBeLessThanOrEqual(innerWidth);
}

/** A control is whole on the screen and at least a thumb high. */
async function expectReachable(page: Page, control: Locator, what: string) {
  await expect.soft(control, `${what} is visible`).toBeVisible();
  const box = await control.boundingBox();
  const screen = page.viewportSize()!;
  expect.soft(box, `${what} has a box`).not.toBeNull();
  if (!box) return;
  expect.soft(box.x, `${what} starts on the screen`).toBeGreaterThanOrEqual(0);
  expect.soft(box.x + box.width, `${what} ends on the screen (${Math.round(box.x + box.width)}px of ${screen.width}px)`).toBeLessThanOrEqual(screen.width);
  expect.soft(box.height, `${what} is at least ${MIN_TARGET}px high (${Math.round(box.height)}px)`).toBeGreaterThanOrEqual(MIN_TARGET);
}

test.describe("removing a photo on a phone", () => {
  test("the button is a thumb high, the question fits the screen with the safe answer in focus, and the photo goes", async ({ page }) => {
    test.setTimeout(120_000);
    await openEntryWithPhotos(page, "Phone photo removal", 2);
    const buttons = page.getByRole("button", { name: /^Odebrat fotografii/ });
    await expect(buttons).toHaveCount(2);
    for (const position of [1, 2]) {
      const button = page.getByRole("button", { name: `Odebrat fotografii ${position}` });
      await button.scrollIntoViewIfNeeded();
      await expectReachable(page, button, `the button of photo ${position}`);
    }
    await expectNoSidewaysScroll(page, "the photos with their buttons");

    // the question is whole on the screen, its answers a thumb high, the safe one in focus
    await page.getByRole("button", { name: "Odebrat fotografii 1" }).click();
    const dialog = page.getByRole("dialog", { name: "Odebrat fotografii?" });
    await expect(dialog).toBeVisible();
    const box = (await dialog.boundingBox())!;
    const screen = page.viewportSize()!;
    expect(box.x, "the question starts on the screen").toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, "and ends on it").toBeLessThanOrEqual(screen.width);
    expect(box.y, "and does not start above it").toBeGreaterThanOrEqual(0);
    expect(box.y + box.height, "and does not end below it").toBeLessThanOrEqual(screen.height);
    await expectReachable(page, dialog.getByRole("button", { name: "Odebrat", exact: true }), 'the answer "Odebrat"');
    await expectReachable(page, dialog.getByRole("button", { name: "Ponechat" }), 'the answer "Ponechat"');
    await expect(dialog.getByRole("button", { name: "Ponechat" })).toBeFocused();
    await expectNoSidewaysScroll(page, "the question");

    await dialog.getByRole("button", { name: "Odebrat", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('img[alt^="Fotka"]')).toHaveCount(1);
    await expect(page.getByRole("status").filter({ hasText: "Fotografie odebrána" })).toBeVisible();
    // the next photo's button has the focus (it was the second, it is the first now)
    await expect(page.getByRole("button", { name: "Odebrat fotografii 1" })).toBeFocused();
    await expectNoSidewaysScroll(page, "the photos after the removal");
  });
});
