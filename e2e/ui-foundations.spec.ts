import { expect, test, type Page } from "@playwright/test";
import { ADMIN_NICKNAME, ADMIN_PASSWORD } from "./global-setup";

/**
 * The shared UI foundations (backlog B3) as a desktop browser sees them: a class given to a shared component wins, the wide
 * admin table is never cut off, a modal dialog locks the page behind it and is described by its question, and the new-password form
 * does not announce a mistake before the person has had the chance to make none. (The phone projects are e2e/mobile-pages.spec.ts.)
 */

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

async function createProject(page: Page): Promise<string> {
  const me = JSON.parse((await page.evaluate(() => localStorage.getItem("user"))) ?? "null") as { id: string };
  const res = await page.request.post("/api/projects", {
    data: {
      name: `E2E Foundations ${Date.now()}`,
      address: "E2E Street 1",
      cadastralArea: "E2E Area",
      parcelNumbers: "1/1",
      builder: "Builder a.s.",
      contractor: "Contractor s.r.o.",
      siteManagerId: me.id,
    },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  return ((await res.json()) as { id: string }).id;
}

test("a class given to a shared component wins: the date field of the entries tab is as wide as a date", async ({ page }) => {
  await login(page);
  const projectId = await createProject(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/projects/${projectId}?tab=reports`);
  const date = page.locator("#new-report-date");
  await expect(date).toBeVisible({ timeout: 15_000 });
  const open = page.getByRole("button", { name: "Otevřít den" });
  const [dateBox, buttonBox] = [(await date.boundingBox())!, (await open.boundingBox())!];
  // `className="w-auto"` used to lose to the field's own w-full: 984 px wide, with the button wrapped below it
  expect(dateBox.width, "the date field is not as wide as the page").toBeLessThan(320);
  expect(Math.abs(dateBox.y - buttonBox.y), "the button is on the same row as the field").toBeLessThan(40);
});

test("the users: every action can be reached at the widths between a tablet and a wide desktop", async ({ page }) => {
  await login(page);
  const row = () => page.locator("tr", { hasText: "manager@stavebni-denik.cz" });
  // Below 1280 px the table is a list of cards (it is about 1250 px wide as a table); from there it is the table, and what does not fit scrolls inside its box.
  for (const width of [700, 900, 1100, 1279, 1280, 1400]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/admin/users");
    await expect(row()).toBeVisible({ timeout: 15_000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), `${width}px: the page does not scroll sideways`).toBeLessThanOrEqual(0);
    const box = page.locator("table").first().locator("xpath=..");
    for (const action of ["Upravit", "Obnovit heslo", "Deaktivovat", "Smazat"]) {
      const button = row().getByRole("button", { name: action, exact: true });
      await button.scrollIntoViewIfNeeded();
      const [b, frame] = [(await button.boundingBox())!, (await box.boundingBox())!];
      // the button is inside what can be seen of its box, so nobody has to scroll the page to reach it
      expect(b.x, `${width}px: "${action}" starts inside the box`).toBeGreaterThanOrEqual(frame.x - 1);
      expect(b.x + b.width, `${width}px: "${action}" ends inside the box`).toBeLessThanOrEqual(frame.x + frame.width + 1);
    }
  }
});

test("a modal dialog locks the page behind it, is described by its question and is closed by Escape", async ({ page }) => {
  test.setTimeout(90_000);
  await login(page);
  const projectId = await createProject(page);
  await page.setViewportSize({ width: 1280, height: 600 });
  await page.goto(`/projects/${projectId}/reports/${pragueDay(0)}`);
  await expect(page.locator('textarea[name="workDescription"]')).toBeVisible({ timeout: 15_000 });
  await page.locator('textarea[name="workDescription"]').fill("Rozepsaný text, který by zmizel.");
  const scrollY = () => page.evaluate(() => window.scrollY);

  const logout = page.getByRole("button", { name: "Odhlásit se", exact: true });
  await logout.click();
  const dialog = page.getByRole("dialog", { name: "Odhlásit se?" });
  await expect(dialog).toBeVisible();

  // The page behind does not scroll, wherever the wheel is. (It is scrolled by a script first, because the click on logout scrolled it
  // to the top: a script may scroll a page that has overflow hidden, a wheel or a finger may not.)
  await page.evaluate(() => window.scrollTo(0, 300));
  expect(await scrollY()).toBe(300);
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).overflow)).toBe("hidden");
  await page.mouse.move(40, 300);
  await page.mouse.wheel(0, 400);
  await page.waitForTimeout(300);
  expect(await scrollY(), "a wheel over the backdrop scrolled the page behind the dialog").toBe(300);

  // It is described by its question, not by everything inside it
  const describedBy = await dialog.getAttribute("aria-describedby");
  expect(describedBy).toBeTruthy();
  await expect(page.locator(`[id="${describedBy}"]`)).toContainText(/neuložené změny|ztratí/i);

  // Escape closes it, the page scrolls again, and the focus is back on the button that opened it
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(logout).toBeFocused();
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).overflow)).not.toBe("hidden");
  await page.mouse.wheel(0, 200);
  await expect.poll(scrollY).toBeGreaterThan(300);
});

test("the new password is not called a mistake while the person is still typing it", async ({ page }) => {
  await login(page);
  await page.goto("/change-password");
  const fresh = page.locator("#new-password");
  const repeat = page.locator("#repeat-password");
  const mismatch = page.locator("#repeat-password-error");
  await fresh.fill("Dlouhe-Heslo-2026!");

  // The start of the same password: it is not wrong yet, nothing is said and the field is not marked
  await repeat.pressSequentially("Dlouhe-Hes");
  await expect(mismatch).toHaveCount(0);
  await expect(repeat).not.toHaveAttribute("aria-invalid", "true");

  // As long as the password: the mistake is there, said politely (a screen reader does not interrupt the typing)
  await repeat.fill("");
  await repeat.pressSequentially("Dlouhe-Heslo-2026?");
  await expect(mismatch).toHaveText(/hesla se neshodují/i);
  await expect(mismatch).toHaveAttribute("role", "status");
  await expect(repeat).toHaveAttribute("aria-invalid", "true");

  // Left alone, it is an alert
  await fresh.focus();
  await expect(mismatch).toHaveAttribute("role", "alert");

  // And once the two are the same there is nothing to say
  await repeat.fill("Dlouhe-Heslo-2026!");
  await expect(mismatch).toHaveCount(0);
  await expect(repeat).not.toHaveAttribute("aria-invalid", "true");

  // A repeat that is shorter and has been left (the person went on to something else) is reported at once
  await repeat.fill("Dlouhe");
  await fresh.focus();
  await expect(mismatch).toHaveText(/hesla se neshodují/i);
  await expect(mismatch).toHaveAttribute("role", "alert");
});
