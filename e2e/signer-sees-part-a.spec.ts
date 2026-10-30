import { expect, test, type APIRequestContext, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { ADMIN_NICKNAME, ADMIN_PASSWORD } from "./global-setup";
import { signPreview } from "./helpers";

/**
 * The signer sees part A before signing (backlog C2b), as a person meets it: the sign dialog shows the identification, the persons with
 * their scope and the authorised persons above the password, with a short digest; when a second session changes any of it between the
 * moment the dialog was opened and the click, the signature is refused with the new text, part A is shown again, the password is gone,
 * and nothing is signed until the person has looked at what is there now. (The server side is in `SignPreviewRoutesTest`, the dialog
 * in `SignEntryDialog.test.tsx`; this is the whole of it in a browser.)
 */

function pragueToday(): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Prague" }).format(new Date());
}

async function post<T = unknown>(api: APIRequestContext, path: string, body: unknown): Promise<T> {
  const res = await api.post(path, { data: body });
  expect(res.ok(), `POST ${path}: ${res.status()} ${await res.text()}`).toBeTruthy();
  return (await res.json()) as T;
}

/** The administrator (the site manager and a manager of the project in these specs), signed in in a context of their own. */
async function session(browser: Browser, baseURL: string | undefined): Promise<{ page: Page; context: BrowserContext; adminId: string }> {
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  await page.goto("/login");
  await page.locator('input[name="nickname"]').fill(ADMIN_NICKNAME);
  await page.locator('input[name="password"]').fill(ADMIN_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 });
  const admin = JSON.parse((await page.evaluate(() => localStorage.getItem("user"))) ?? "null") as { id: string };
  return { page, context, adminId: admin.id };
}

/** A project of its own with a scope for its manager and an authorised person, and a draft for today. */
async function newProject(api: APIRequestContext, adminId: string) {
  const name = `Část A ${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const project = await post<{ id: string }>(api, "/api/projects", {
    name,
    address: "Kotlářská 12, Brno",
    cadastralArea: "Veveří",
    parcelNumbers: "450/1",
    builder: "Stavebník a.s., Brno, IČO 11111111",
    contractor: "Zhotovitel s.r.o., Brno, IČO 22222222",
    siteManagerId: adminId,
  });
  await post(api, `/api/projects/${project.id}/members`, { userId: adminId, role: "BOSS", scope: "Celé dílo, vedení stavby" });
  await post(api, `/api/projects/${project.id}/authorized-persons`, { name: "Ing. Petr Černý", company: "Architekti s.r.o.", authorization: "Autorský dozor" });
  const day = pragueToday();
  await post(api, `/api/projects/${project.id}/reports/${day}`, {
    date: day,
    workDescription: "Betonáž stropní desky",
    workersByTrade: JSON.stringify([{ trade: "Zedník", count: 2 }]),
    expectNew: true,
  });
  return { id: project.id, name, day };
}

const SCOPE = "Celé dílo, vedení stavby";
const NEW_SCOPE = "Jen přístavba, statika";

test.describe("the signer sees part A before signing", () => {
  test("the dialog shows it above the password, a change made meanwhile is refused with the new text, and the second look signs", async ({ browser, baseURL }) => {
    test.setTimeout(120_000);
    const first = await session(browser, baseURL);
    const second = await session(browser, baseURL);
    try {
      const project = await newProject(first.context.request, first.adminId);
      const { page } = first;
      await page.goto(`/projects/${project.id}/reports/${project.day}`);
      const open = page.getByRole("button", { name: /podepsat a uzamknout/i });
      await expect(open).toBeEnabled({ timeout: 15_000 });
      await open.click();

      // Part A is above the password: the identification, the persons with their scope, the authorised persons, and a short digest.
      const dialog = page.getByRole("dialog", { name: /podepsat a uzamknout záznam/i });
      const region = dialog.getByRole("region", { name: /údaje o stavbě, které podepisujete/i });
      await expect(region.getByText(project.name)).toBeVisible({ timeout: 15_000 });
      for (const shown of [
        "Zhotovitel (název a sídlo, IČO)",
        "Zhotovitel s.r.o., Brno, IČO 22222222",
        "Hlavní stavbyvedoucí",
        "ČKAIT 0000000",
        "Rozsah oprávnění a odpovědnosti",
        SCOPE,
        "Ing. Petr Černý",
        "Architekti s.r.o.",
        "Autorský dozor",
      ]) {
        await expect(region, `part A says ${shown}`).toContainText(shown);
      }
      const seen = await signPreview(second.context.request, project.id, project.day);
      await expect(dialog.getByText(/Otisk údajů o stavbě/)).toContainText(`${seen.partASha256.slice(0, 8)}…`);
      await expect(dialog.getByText(/stanou se součástí podpisu/)).toBeVisible();
      // What a signer has to read comes first: the block has the focus, not the password (a phone's keyboard would cover it).
      await expect(region).toBeFocused();
      const order = await region.evaluate(
        (el, selector) => Boolean(el.compareDocumentPosition(document.querySelector(selector)!) & Node.DOCUMENT_POSITION_FOLLOWING),
        "#sign-password",
      );
      expect(order, "the password field is after the block").toBe(true);

      // A second session changes the scope of the manager while this dialog is open.
      await post(second.context.request, `/api/projects/${project.id}/members`, { userId: second.adminId, role: "BOSS", scope: NEW_SCOPE });

      await dialog.getByLabel("Heslo").fill(ADMIN_PASSWORD);
      await dialog.getByRole("button", { name: "Podepsat", exact: true }).click();

      // Refused with the new text; part A is shown again with what changed; the password is gone; nothing is signed.
      const notice = dialog.getByRole("alert");
      await expect(notice).toContainText("Údaje o stavbě se mezi tím změnily; zkontrolujte je znovu.", { timeout: 15_000 });
      await expect(notice).toContainText(/Změna u osoby .*: rozsah oprávnění a odpovědnosti/);
      await expect(region).toContainText(NEW_SCOPE);
      await expect(region).not.toContainText(SCOPE);
      await expect(dialog.getByLabel("Heslo")).toHaveValue("");
      await expect(dialog.getByRole("button", { name: "Podepsat", exact: true })).toBeDisabled();
      await expect(region).toBeFocused();
      const now = await signPreview(second.context.request, project.id, project.day);
      expect(now.partASha256).not.toBe(seen.partASha256);
      await expect(dialog.getByText(/Otisk údajů o stavbě/)).toContainText(`${now.partASha256.slice(0, 8)}…`);
      await expect(page.getByText("Podepsáno", { exact: true })).toHaveCount(0);
      const stored = (await (await second.context.request.get(`/api/projects/${project.id}/reports/${project.day}`)).json()) as { isSigned?: boolean };
      expect(stored.isSigned, "the entry is still a draft").toBeFalsy();

      // Having looked at what is there now, the signer signs it.
      await dialog.getByLabel("Heslo").fill(ADMIN_PASSWORD);
      await dialog.getByRole("button", { name: "Podepsat", exact: true }).click();
      await expect(dialog).toBeHidden({ timeout: 15_000 });
      await expect(page.getByText("Podepsáno", { exact: true })).toBeVisible({ timeout: 15_000 });
      // The focus is somewhere (the button that asked is gone with the answer), not on the document.
      expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe("BODY");

      // What was stored is what the digest named: the signature checks out, and a later change does not reach the signed entry.
      const entry = (await (await second.context.request.get(`/api/projects/${project.id}/reports/${project.day}`)).json()) as { id: string };
      const check = (await (await second.context.request.get(`/api/reports/${entry.id}/signature`)).json()) as {
        signed: boolean;
        contentMatches: boolean | null;
        signatureFormat: number;
      };
      expect(check).toMatchObject({ signed: true, contentMatches: true, signatureFormat: 3 });
    } finally {
      await first.context.close();
      await second.context.close();
    }
  });

  test("when it is the entry that changed, and not part A, the dialog hands it back to the page as before", async ({ browser, baseURL }) => {
    test.setTimeout(120_000);
    const first = await session(browser, baseURL);
    const second = await session(browser, baseURL);
    try {
      const project = await newProject(first.context.request, first.adminId);
      const { page } = first;
      await page.goto(`/projects/${project.id}/reports/${project.day}`);
      const open = page.getByRole("button", { name: /podepsat a uzamknout/i });
      await expect(open).toBeEnabled({ timeout: 15_000 });
      await open.click();
      const dialog = page.getByRole("dialog", { name: /podepsat a uzamknout záznam/i });
      await expect(dialog.getByRole("region", { name: /údaje o stavbě, které podepisujete/i }).getByText(project.name)).toBeVisible({ timeout: 15_000 });

      // A second session saves the entry (its text is what the signature covers), part A stays as it is.
      await post(second.context.request, `/api/projects/${project.id}/reports/${project.day}`, { workDescription: "Betonáž stropní desky, doplněno" });

      await dialog.getByLabel("Heslo").fill(ADMIN_PASSWORD);
      await dialog.getByRole("button", { name: "Podepsat", exact: true }).click();

      await expect(dialog).toBeHidden({ timeout: 15_000 });
      await expect(page.getByRole("alert").filter({ hasText: /Záznam se od načtení změnil/ })).toBeVisible();
      await expect(page.getByText("Podepsáno", { exact: true })).toHaveCount(0);
    } finally {
      await first.context.close();
      await second.context.close();
    }
  });

  test("when the entry AND part A changed, the dialog does not keep a stale version: the page loads the entry, and the next dialog signs with one password", async ({
    browser,
    baseURL,
  }) => {
    test.setTimeout(120_000);
    const first = await session(browser, baseURL);
    const second = await session(browser, baseURL);
    try {
      const project = await newProject(first.context.request, first.adminId);
      const { page } = first;
      await page.goto(`/projects/${project.id}/reports/${project.day}`);
      const open = page.getByRole("button", { name: /podepsat a uzamknout/i });
      await expect(open).toBeEnabled({ timeout: 15_000 });
      await open.click();
      const dialog = page.getByRole("dialog", { name: /podepsat a uzamknout záznam/i });
      await expect(dialog.getByRole("region", { name: /údaje o stavbě, které podepisujete/i }).getByText(project.name)).toBeVisible({ timeout: 15_000 });

      // A second session changes the entry and the scope of the manager.
      await post(second.context.request, `/api/projects/${project.id}/reports/${project.day}`, { workDescription: "Betonáž stropní desky, doplněno" });
      await post(second.context.request, `/api/projects/${project.id}/members`, { userId: second.adminId, role: "BOSS", scope: NEW_SCOPE });

      await dialog.getByLabel("Heslo").fill(ADMIN_PASSWORD);
      await dialog.getByRole("button", { name: "Podepsat", exact: true }).click();

      // The page has the entry's refusal and the dialog is gone: a dialog that stayed would send the old version again and be refused again.
      await expect(dialog).toBeHidden({ timeout: 15_000 });
      await expect(page.getByRole("alert").filter({ hasText: /Záznam se od načtení změnil/ })).toBeVisible();
      await page.getByRole("button", { name: "Načíst aktuální verzi" }).click();
      await expect(page.locator('textarea[name="workDescription"]')).toHaveValue("Betonáž stropní desky, doplněno", { timeout: 15_000 });

      // The next dialog shows the new part A, and one password signs.
      await expect(open).toBeEnabled();
      await open.click();
      const again = page.getByRole("dialog", { name: /podepsat a uzamknout záznam/i });
      await expect(again.getByRole("region", { name: /údaje o stavbě, které podepisujete/i })).toContainText(NEW_SCOPE, { timeout: 15_000 });
      await again.getByLabel("Heslo").fill(ADMIN_PASSWORD);
      await again.getByRole("button", { name: "Podepsat", exact: true }).click();
      await expect(again).toBeHidden({ timeout: 15_000 });
      await expect(page.getByText("Podepsáno", { exact: true })).toBeVisible({ timeout: 15_000 });
    } finally {
      await first.context.close();
      await second.context.close();
    }
  });

  test("a signature that the server answers after the person pressed Zavřít still shows the signed entry", async ({ browser, baseURL }) => {
    test.setTimeout(120_000);
    const first = await session(browser, baseURL);
    try {
      const project = await newProject(first.context.request, first.adminId);
      const { page } = first;
      // The server does not answer the signature until the test lets it (the request has reached it and the entry is signed there).
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => (release = resolve));
      await page.route(/\/api\/projects\/[^/]+\/reports\/[^/]+\/sign$/, async (route) => {
        const response = await route.fetch();
        await gate;
        await route.fulfill({ response });
      });

      await page.goto(`/projects/${project.id}/reports/${project.day}`);
      const open = page.getByRole("button", { name: /podepsat a uzamknout/i });
      await expect(open).toBeEnabled({ timeout: 15_000 });
      await open.click();
      const dialog = page.getByRole("dialog", { name: /podepsat a uzamknout záznam/i });
      await expect(dialog.getByRole("region", { name: /údaje o stavbě, které podepisujete/i }).getByText(project.name)).toBeVisible({ timeout: 15_000 });
      await dialog.getByLabel("Heslo").fill(ADMIN_PASSWORD);
      await dialog.getByRole("button", { name: "Podepsat", exact: true }).click();

      // 20 s without an answer: the dialog says so and can be closed, and the page shows an entry that nobody knows to be signed.
      await expect(dialog.getByText("Server neodpovídá.")).toBeVisible({ timeout: 40_000 });
      await dialog.getByRole("button", { name: "Zavřít" }).click();
      await expect(dialog).toBeHidden();
      await expect(page.getByText("Podepsáno", { exact: true })).toHaveCount(0);

      // The answer comes (200): the page shows the signed entry, and the button that signs is gone.
      release();
      await expect(page.getByText("Podepsáno", { exact: true })).toBeVisible({ timeout: 15_000 });
      await expect(page.getByRole("button", { name: /podepsat a uzamknout/i })).toHaveCount(0);
    } finally {
      await first.context.close();
    }
  });
});
