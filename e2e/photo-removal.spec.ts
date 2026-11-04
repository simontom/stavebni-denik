import { expect, test, type APIRequestContext, type Browser, type BrowserContext, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { ADMIN_PASSWORD, INVESTOR_NICKNAME, INVESTOR_PASSWORD } from "./global-setup";
import { makeProject, pragueDay, saveEntry, signEntry, signInAdmin } from "./helpers";

/**
 * Removing a photo (backlog A4, the owner's decision of 2026-11-04): from an entry that is not signed, by the manager of the project (any photo)
 * or by the worker who uploaded it (their own), nobody else, nobody on a signed entry. The button follows what the server says (`canDelete` of
 * every photo), the question is the application's own dialog (safe answer in focus, the server's refusal inside it), and the focus goes on to the next
 * photo's button, else to the heading of the photos. A phone is `mobile-photo-removal.spec.ts`.
 *
 * Every test makes a project of its own through the API. The administrator of the suite is its manager; the worker and the client are the seeded accounts.
 */

const JPEG = fs.readFileSync(path.resolve(__dirname, "fixtures/dummy-photo.jpg"));
const WORKER_ID = "55555555-5555-5555-5555-555555555555";
const WORKER_NICKNAME = "worker@stavebni-denik.cz";
const INVESTOR_ID = "22222222-2222-2222-2222-222222222222";

interface Person {
  page: Page;
  context: BrowserContext;
  request: APIRequestContext;
}

/** A person signed in, in a context of their own. */
async function person(browser: Browser, baseURL: string | undefined, nickname?: string, password?: string): Promise<Person> {
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  if (!nickname) {
    await signInAdmin(page);
  } else {
    await page.goto("/login");
    await page.locator('input[name="nickname"]').fill(nickname);
    await page.locator('input[name="password"]').fill(password ?? "");
    await page.locator('button[type="submit"]').click();
    await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 });
  }
  return { page, context, request: context.request };
}

interface Site {
  admin: Person;
  projectId: string;
  projectPath: string;
  day: string;
  url: string;
}

/** A project with the worker and the client as members and the administrator as manager, and a saved (unsigned) entry for today. */
async function newSite(browser: Browser, baseURL: string | undefined, label: string): Promise<Site> {
  const admin = await person(browser, baseURL);
  const { projectId, projectPath } = await makeProject(admin.page, label);
  for (const [userId, role] of [
    [WORKER_ID, "WORKER"],
    [INVESTOR_ID, "INVESTOR"],
  ] as const) {
    const res = await admin.request.post(`/api/projects/${projectId}/members`, { data: { userId, role } });
    expect(res.ok(), `POST members: ${res.status()} ${await res.text()}`).toBeTruthy();
  }
  const day = pragueDay(0);
  await saveEntry(admin.page, projectId, day);
  return { admin, projectId, projectPath, day, url: `${projectPath}/reports/${day}` };
}

/** Stores a photo on the entry as [who] (what the page's uploader does, without the page). Returns its id. */
async function addPhoto(who: Person, site: Site, name: string): Promise<string> {
  const res = await who.request.post("/api/photos/upload", {
    multipart: { reportId: site.day, projectId: site.projectId, photo: { name, mimeType: "image/jpeg", buffer: JPEG } },
  });
  expect(res.ok(), `the photo is stored: ${res.status()} ${await res.text()}`).toBeTruthy();
  return ((await res.json()) as { id: string }).id;
}

/** The ids of the photos the server has on the entry, in its order (not what the page shows). */
async function serverPhotos(site: Site): Promise<string[]> {
  const res = await site.admin.request.get(`/api/projects/${site.projectId}/reports/${site.day}`);
  expect(res.ok()).toBeTruthy();
  return ((await res.json()) as { photos: { id: string }[] }).photos.map((p) => p.id);
}

const pictures = (page: Page) => page.locator('img[alt^="Fotka"]');
const removeButtons = (page: Page) => page.getByRole("button", { name: /^Odebrat fotografii/ });
const question = (page: Page) => page.getByRole("dialog", { name: "Odebrat fotografii?" });
const photosHeading = (page: Page) => page.getByRole("heading", { level: 2, name: "Fotodokumentace" });
const removedStatus = (page: Page) => page.getByRole("status").filter({ hasText: "Fotografie odebrána" });

async function open(person: Person, site: Site, shows: number) {
  await person.page.goto(site.url);
  await expect(pictures(person.page)).toHaveCount(shows, { timeout: 15_000 });
}

/** Asks the question for the photo at [position] and answers yes. */
async function removeAt(page: Page, position: number) {
  await page.getByRole("button", { name: `Odebrat fotografii ${position}` }).click();
  const dialog = question(page);
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Odebrat", exact: true }).click();
  await expect(dialog).toHaveCount(0);
}

test.describe("removing a photo from an entry that is not signed", () => {
  test("a worker removes the photo they uploaded and has no button on the manager's; the question keeps the photo by default", async ({ browser, baseURL }) => {
    test.setTimeout(120_000);
    const site = await newSite(browser, baseURL, "Photo worker");
    const worker = await person(browser, baseURL, WORKER_NICKNAME, ADMIN_PASSWORD);
    const client = await person(browser, baseURL, INVESTOR_NICKNAME, INVESTOR_PASSWORD);
    try {
      const managers = await addPhoto(site.admin, site, "manager.jpg");
      const workers = await addPhoto(worker, site, "worker.jpg");
      await open(worker, site, 2);
      const page = worker.page;

      // The worker's button is on their own photo (the second) and nowhere else; the server says the same.
      await expect(removeButtons(page)).toHaveCount(1);
      await expect(page.getByRole("button", { name: "Odebrat fotografii 2" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Odebrat fotografii 1" })).toHaveCount(0);
      expect((await worker.request.delete(`/api/photos/${managers}`)).status(), "the server refuses the manager's photo to the worker").toBe(403);

      // The question: named by what it asks, says it cannot be undone and that the removal stays in the audit, and the safe answer has the focus.
      const opener = page.getByRole("button", { name: "Odebrat fotografii 2" });
      await opener.click();
      const dialog = question(page);
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText("nejde ji vrátit");
      await expect(dialog).toContainText("v auditu");
      await expect(dialog.getByRole("button", { name: "Ponechat" })).toBeFocused();
      await expect(dialog.getByRole("button", { name: "Odebrat", exact: true })).toBeVisible();

      // Escape is "no": nothing is removed, and the focus is back on the button that asked.
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect(opener).toBeFocused();
      await expect(pictures(page)).toHaveCount(2);
      expect(await serverPhotos(site)).toEqual([managers, workers]);

      // Yes: the photo is gone from the list and from the server, it is said politely, and (it was the last) the focus is on the heading of the photos.
      await removeAt(page, 2);
      await expect(pictures(page)).toHaveCount(1);
      await expect(removedStatus(page)).toBeVisible();
      await expect(photosHeading(page)).toBeFocused();
      await expect(removeButtons(page)).toHaveCount(0);
      expect(await serverPhotos(site)).toEqual([managers]);
      expect((await worker.request.get(`/api/photos/${workers}`)).status(), "a removed photo is not served").toBe(404);
      expect((await worker.request.get(`/api/photos/${workers}/thumb`)).status()).toBe(404);

      // The client reads the photo and has no way to remove it; the server agrees.
      await open(client, site, 1);
      await expect(removeButtons(client.page)).toHaveCount(0);
      expect((await client.request.delete(`/api/photos/${managers}`)).status()).toBe(403);
    } finally {
      await client.context.close();
      await worker.context.close();
      await site.admin.context.close();
    }
  });

  test("the manager removes any photo, a worker's too, and the focus goes to the next photo's button, and at the end to the heading", async ({ browser, baseURL }) => {
    test.setTimeout(120_000);
    const site = await newSite(browser, baseURL, "Photo manager");
    const worker = await person(browser, baseURL, WORKER_NICKNAME, ADMIN_PASSWORD);
    try {
      const first = await addPhoto(site.admin, site, "a.jpg");
      const second = await addPhoto(worker, site, "b.jpg");
      const third = await addPhoto(site.admin, site, "c.jpg");
      await open(site.admin, site, 3);
      const page = site.admin.page;
      await expect(removeButtons(page)).toHaveCount(3);
      expect(await serverPhotos(site)).toEqual([first, second, third]);

      // the first: the focus goes to the button of the photo that was the second (the worker's), now the first
      await removeAt(page, 1);
      await expect(pictures(page)).toHaveCount(2);
      await expect(page.locator(`#remove-photo-${second}`)).toBeFocused();
      await expect(page.getByRole("button", { name: "Odebrat fotografii 1" })).toBeFocused();
      await expect(removedStatus(page)).toBeVisible();
      expect(await serverPhotos(site)).toEqual([second, third]);

      // the worker's photo, by the manager: the next is the third
      await removeAt(page, 1);
      await expect(pictures(page)).toHaveCount(1);
      await expect(page.locator(`#remove-photo-${third}`)).toBeFocused();
      expect(await serverPhotos(site)).toEqual([third]);

      // the last one: nothing follows, so the heading of the photos has the focus
      await removeAt(page, 1);
      await expect(pictures(page)).toHaveCount(0);
      await expect(photosHeading(page)).toBeFocused();
      expect(await serverPhotos(site)).toEqual([]);
    } finally {
      await worker.context.close();
      await site.admin.context.close();
    }
  });

  test("a photo that was just uploaded through the page has its button at once, and can be removed", async ({ browser, baseURL }) => {
    test.setTimeout(120_000);
    const site = await newSite(browser, baseURL, "Photo fresh");
    try {
      const page = site.admin.page;
      await page.goto(site.url);
      await expect(page.locator("input#photo-files")).toBeEnabled({ timeout: 15_000 });
      await page.locator("input#photo-files").setInputFiles([{ name: "nova.jpg", mimeType: "image/jpeg", buffer: JPEG }]);
      await page.getByRole("button", { name: "Nahrát fotky" }).click();
      await expect(pictures(page)).toHaveCount(1, { timeout: 15_000 });
      await expect(page.getByRole("button", { name: "Odebrat fotografii 1" })).toBeVisible();
      expect(await serverPhotos(site)).toHaveLength(1);

      await removeAt(page, 1);
      await expect(pictures(page)).toHaveCount(0);
      expect(await serverPhotos(site)).toEqual([]);
      // a reload shows the same (the photo is gone, not hidden)
      await page.reload();
      await expect(page.locator("input#photo-files")).toBeEnabled({ timeout: 15_000 });
      await expect(pictures(page)).toHaveCount(0);
    } finally {
      await site.admin.context.close();
    }
  });

  test("what the server refuses is said inside the dialog (an alert), which stays open, and the same answer can be given again", async ({ browser, baseURL }) => {
    test.setTimeout(120_000);
    const site = await newSite(browser, baseURL, "Photo refused");
    try {
      const photo = await addPhoto(site.admin, site, "a.jpg");
      await open(site.admin, site, 1);
      const page = site.admin.page;
      let failing = true;
      await page.route("**/api/photos/*", (route) => {
        if (route.request().method() === "DELETE" && failing) {
          return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Vnitřní chyba serveru" }) });
        }
        return route.continue();
      });

      await page.getByRole("button", { name: "Odebrat fotografii 1" }).click();
      const dialog = question(page);
      await dialog.getByRole("button", { name: "Odebrat", exact: true }).click();

      await expect(dialog.getByRole("alert")).toHaveText("Vnitřní chyba serveru");
      await expect(dialog, "the dialog stays open").toBeVisible();
      await expect(pictures(page)).toHaveCount(1);
      const confirm = dialog.getByRole("button", { name: "Odebrat", exact: true });
      await expect(confirm, "the answer can be given again").not.toHaveAttribute("aria-disabled", "true");
      expect(await serverPhotos(site)).toEqual([photo]);

      failing = false;
      await confirm.click();
      await expect(dialog).toHaveCount(0);
      await expect(pictures(page)).toHaveCount(0);
      expect(await serverPhotos(site)).toEqual([]);
    } finally {
      await site.admin.context.close();
    }
  });

  test("a removal whose answer is lost is said so, and the second try, which finds nothing, is taken as removed: the status and the focus are those of a removal", async ({
    browser,
    baseURL,
  }) => {
    test.setTimeout(120_000);
    const site = await newSite(browser, baseURL, "Photo lost answer");
    const worker = await person(browser, baseURL, WORKER_NICKNAME, ADMIN_PASSWORD);
    try {
      const first = await addPhoto(worker, site, "a.jpg");
      const second = await addPhoto(worker, site, "b.jpg");
      await open(site.admin, site, 2);
      const page = site.admin.page;
      expect(await serverPhotos(site)).toEqual([first, second]);
      // The first request reaches the server and removes the photo, and its answer is lost on the way (the connection is reset).
      let lose = true;
      await page.route("**/api/photos/*", async (route) => {
        if (route.request().method() === "DELETE" && lose) {
          lose = false;
          const done = await site.admin.request.delete(route.request().url());
          expect(done.status(), "the server removed it").toBe(204);
          return route.abort("connectionreset");
        }
        return route.continue();
      });

      await page.getByRole("button", { name: "Odebrat fotografii 1" }).click();
      const dialog = question(page);
      await dialog.getByRole("button", { name: "Odebrat", exact: true }).click();
      await expect(dialog.getByRole("alert")).toContainText("Spojení se serverem se přerušilo");
      await expect(dialog, "the dialog stays open for another try").toBeVisible();
      await expect(pictures(page)).toHaveCount(2);
      expect(await serverPhotos(site), "the photo is gone on the server all the same").toEqual([second]);

      // Again: the server finds no such photo, and that is what the first request had done.
      await dialog.getByRole("button", { name: "Odebrat", exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect(pictures(page)).toHaveCount(1);
      await expect(removedStatus(page), "said as a removal, not as a refusal").toBeVisible();
      await expect(page.locator(`#remove-photo-${second}`), "the next photo's button has the focus").toBeFocused();
      expect(await serverPhotos(site)).toEqual([second]);
    } finally {
      await worker.context.close();
      await site.admin.context.close();
    }
  });

  test("a photo that somebody else has removed already is a refusal with the server's words, off the list, and Escape puts the focus on the heading of the photos", async ({
    browser,
    baseURL,
  }) => {
    test.setTimeout(120_000);
    const site = await newSite(browser, baseURL, "Photo gone already");
    const worker = await person(browser, baseURL, WORKER_NICKNAME, ADMIN_PASSWORD);
    try {
      const gone = await addPhoto(worker, site, "a.jpg");
      await open(site.admin, site, 1);
      const page = site.admin.page;
      // Somebody else removes it while this page still shows it with its button.
      expect((await site.admin.request.delete(`/api/photos/${gone}`)).status()).toBe(204);

      await page.getByRole("button", { name: "Odebrat fotografii 1" }).click();
      const dialog = question(page);
      await dialog.getByRole("button", { name: "Odebrat", exact: true }).click();
      await expect(dialog.getByRole("alert")).toHaveText("Fotografie nenalezena");
      await expect(dialog).toBeVisible();
      await expect(pictures(page), "the page has read the entry again: the photo is off the list").toHaveCount(0);
      await expect(removedStatus(page), "a refusal says no removal was made").toHaveCount(0);

      // Escape is "no". The button that asked is gone with the photo: the focus is on the heading of the photos, not on the top of the page.
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect(photosHeading(page)).toBeFocused();
    } finally {
      await worker.context.close();
      await site.admin.context.close();
    }
  });

  test("an entry that was signed meanwhile: the server answers 409, the dialog says why and where a correction goes, and the page reads the entry again", async ({
    browser,
    baseURL,
  }) => {
    test.setTimeout(120_000);
    const site = await newSite(browser, baseURL, "Photo signed meanwhile");
    const worker = await person(browser, baseURL, WORKER_NICKNAME, ADMIN_PASSWORD);
    try {
      const photo = await addPhoto(worker, site, "a.jpg");
      await open(site.admin, site, 1);
      const page = site.admin.page;
      await expect(page.getByRole("button", { name: "Odebrat fotografii 1" })).toBeVisible();

      // somebody signs the entry while this page is open (the page still shows the button)
      await signEntry(site.admin.request, site.projectId, site.day, ADMIN_PASSWORD);

      await page.getByRole("button", { name: "Odebrat fotografii 1" }).click();
      const dialog = question(page);
      await dialog.getByRole("button", { name: "Odebrat", exact: true }).click();
      const alert = dialog.getByRole("alert");
      await expect(alert).toContainText("podepsaného záznamu");
      await expect(alert).toContainText("dodatkem");
      await expect(dialog).toBeVisible();

      // the page behind it has read the entry again: signed, no button, the photo still there
      await expect(removeButtons(page)).toHaveCount(0);
      await expect(page.getByText("Podepsáno", { exact: true })).toHaveCount(1);
      await dialog.getByRole("button", { name: "Ponechat" }).click();
      await expect(dialog).toHaveCount(0);
      await expect(pictures(page)).toHaveCount(1);
      // the button that asked is gone: the focus is on the heading of the photos, not on the top of the document
      await expect(photosHeading(page)).toBeFocused();
      expect(await serverPhotos(site)).toEqual([photo]);
    } finally {
      await worker.context.close();
      await site.admin.context.close();
    }
  });
});

test.describe("a signed entry never loses a photo, and nobody who may not remove one is offered the button", () => {
  test("no button for the manager, the worker or the client; the server answers 409 to those who could have removed it and 403 to the client", async ({ browser, baseURL }) => {
    test.setTimeout(120_000);
    const site = await newSite(browser, baseURL, "Photo signed");
    const worker = await person(browser, baseURL, WORKER_NICKNAME, ADMIN_PASSWORD);
    const client = await person(browser, baseURL, INVESTOR_NICKNAME, INVESTOR_PASSWORD);
    try {
      const photos = [await addPhoto(worker, site, "a.jpg"), await addPhoto(worker, site, "b.jpg")];
      // before the signature the manager and the worker are offered the button; after it nobody is
      await open(site.admin, site, 2);
      await expect(removeButtons(site.admin.page)).toHaveCount(2);
      await signEntry(site.admin.request, site.projectId, site.day, ADMIN_PASSWORD);

      for (const who of [site.admin, worker, client]) {
        await open(who, site, 2);
        await expect(who.page.getByRole("region", { name: "Podpis záznamu" })).toBeVisible({ timeout: 15_000 });
        await expect(removeButtons(who.page)).toHaveCount(0);
      }

      const refusal = await site.admin.request.delete(`/api/photos/${photos[0]}`);
      expect(refusal.status(), "the manager of a signed entry").toBe(409);
      expect(((await refusal.json()) as { error: string }).error).toContain("dodatkem");
      expect((await worker.request.delete(`/api/photos/${photos[1]}`)).status(), "the worker who uploaded it").toBe(409);
      expect((await client.request.delete(`/api/photos/${photos[0]}`)).status(), "the client").toBe(403);
      expect(await serverPhotos(site)).toEqual(photos);
    } finally {
      await client.context.close();
      await worker.context.close();
      await site.admin.context.close();
    }
  });

  test("an administrator who is not a member of the project has no button and no right", async ({ browser, baseURL }) => {
    test.setTimeout(120_000);
    const site = await newSite(browser, baseURL, "Photo outsider");
    // The other administrator of the seed (admin@stavebni-denik.cz) is not a member of this project.
    const outsider = await person(browser, baseURL, "admin@stavebni-denik.cz", ADMIN_PASSWORD);
    try {
      const photo = await addPhoto(site.admin, site, "a.jpg");
      await open(outsider, site, 1);
      await expect(removeButtons(outsider.page)).toHaveCount(0);
      expect((await outsider.request.delete(`/api/photos/${photo}`)).status()).toBe(403);
      expect(await serverPhotos(site)).toEqual([photo]);
    } finally {
      await outsider.context.close();
      await site.admin.context.close();
    }
  });
});
