import { expect, test, type Page } from "@playwright/test";
import { ADMIN_NICKNAME, ADMIN_PASSWORD } from "./global-setup";

async function login(page: Page) {
  await page.goto("/login");
  await page.locator('input[name="nickname"]').fill(ADMIN_NICKNAME);
  await page.locator('input[name="password"]').fill(ADMIN_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 });
}

/**
 * A call to the API made from inside the page, so that it carries the session exactly as the SPA does. (The session cookie of the
 * production build is Secure, and Playwright's own request client does not send a Secure cookie over http://localhost, which a
 * browser does.)
 */
async function api(page: Page, method: string, path: string, body?: unknown) {
  const answer = await page.evaluate(
    async ({ method, path, body }) => {
      const res = await fetch(path, {
        method,
        headers: body === undefined ? {} : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: "same-origin",
      });
      return { ok: res.ok, status: res.status, text: await res.text() };
    },
    { method, path, body },
  );
  expect(answer.ok, `${method} ${path} -> ${answer.status} ${answer.text}`).toBeTruthy();
  return JSON.parse(answer.text);
}

test("the manager of a project replaces its site manager with another manager of it", async ({ page }) => {
  test.setTimeout(90_000);
  await login(page);

  // A project, managed by the administrator account.
  await page.goto("/projects/new");
  await page.locator('input[name="name"]').fill(`E2E Site manager ${Date.now()}`);
  await page.locator('input[name="address"]').fill("Karlova 15, Brno");
  await page.locator('input[name="cadastralArea"]').fill("Brno-střed");
  await page.locator('input[name="parcelNumbers"]').fill("450/1");
  await page.locator('input[name="builder"]').fill("Město Brno");
  await page.locator('input[name="contractor"]').fill("Stavitel a.s.");
  await page.locator('button[id="siteManagerId"]').click();
  await page.getByRole("option", { name: new RegExp(ADMIN_NICKNAME) }).click();
  await page.getByRole("button", { name: /založit zakázku/i }).click();
  await expect(page).toHaveURL(/\/projects\/([0-9a-fA-F-]{36})$/);
  const projectId = page.url().split("/").pop()!;

  // A second manager with a ČKAIT number, who is a manager of the project (set up through the API).
  const stamp = Date.now();
  const deputyName = `Zástupce ${stamp}`;
  const created = await api(page, "POST", "/api/users", { nickname: `e2e-deputy-${stamp}`, displayName: deputyName, role: "BOSS", ckaitNumber: "0012345" });
  const deputyId = created.user.id as string;
  await api(page, "POST", `/api/projects/${projectId}/members`, { userId: deputyId, role: "BOSS" });

  await page.goto(`/projects/${projectId}`);
  await expect(page.getByText("Hlavní stavbyvedoucí:")).toBeVisible({ timeout: 15_000 });

  // The change: another manager of the project, with a reason.
  await page.getByRole("button", { name: "Změnit stavbyvedoucího" }).click();
  await page.getByLabel(/nový stavbyvedoucí/i).selectOption({ label: `${deputyName} (e2e-deputy-${stamp})` });
  await page.getByLabel(/důvod změny/i).fill("Původní stavbyvedoucí odešel ze společnosti");
  await page.getByRole("button", { name: "Změnit stavbyvedoucího" }).last().click();

  // The page names the new site manager, and the previous one is no longer offered a change to themselves.
  await expect(page.getByText(deputyName).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByLabel(/nový stavbyvedoucí/i)).toHaveCount(0);
  const project = await api(page, "GET", `/api/projects/${projectId}`);
  expect(project.siteManagerId).toBe(deputyId);

  // The members tab marks who the site manager is: the new one, in the row of the new one.
  await page.goto(`/projects/${projectId}?tab=members`);
  const deputyRow = page.getByRole("row").filter({ hasText: `e2e-deputy-${stamp}` });
  await expect(deputyRow.getByText("Hlavní stavbyvedoucí")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Hlavní stavbyvedoucí")).toHaveCount(1);
});
