import { expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { ADMIN_NICKNAME, ADMIN_PASSWORD } from "./global-setup";

/** A date in Prague, [offsetDays] from today, as YYYY-MM-DD. */
export function pragueDay(offsetDays: number): string {
  const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Prague" }).format(new Date());
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

/** Signs in as the administrator of the suite (the stavbyvedoucí of the projects it makes). */
export async function signInAdmin(page: Page): Promise<void> {
  await page.goto("/login");
  await page.locator('input[name="nickname"]').fill(ADMIN_NICKNAME);
  await page.locator('input[name="password"]').fill(ADMIN_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 });
}

/** A project of its own, made through the API by the signed-in administrator, who is its site manager. Returns its id and the path of its page. */
export async function makeProject(page: Page, label: string): Promise<{ projectId: string; projectPath: string }> {
  const admin = JSON.parse((await page.evaluate(() => localStorage.getItem("user"))) ?? "null") as { id: string };
  const res = await page.request.post("/api/projects", {
    data: {
      name: `E2E ${label} ${Date.now()}`,
      address: "E2E Street 1",
      cadastralArea: "E2E Area",
      parcelNumbers: "1/1",
      builder: "Builder a.s.",
      contractor: "Contractor s.r.o.",
      siteManagerId: admin.id,
    },
  });
  expect(res.ok(), `POST /api/projects: ${res.status()} ${await res.text()}`).toBeTruthy();
  const { id } = (await res.json()) as { id: string };
  return { projectId: id, projectPath: `/projects/${id}` };
}

/** Saves an entry for [day] through the API (what a person does with the form, without the form). Returns the version it has. */
export async function saveEntry(page: Page, projectId: string, day: string, extra: Record<string, unknown> = {}): Promise<{ id: string; updatedAt: string }> {
  const res = await page.request.post(`/api/projects/${projectId}/reports/${day}`, {
    data: { date: day, workDescription: "Betonáž stropu", workersByTrade: JSON.stringify([{ trade: "Zedník", count: 2 }]), expectNew: true, ...extra },
  });
  expect(res.ok(), `POST …/reports/${day}: ${res.status()} ${await res.text()}`).toBeTruthy();
  return (await res.json()) as { id: string; updatedAt: string };
}

/**
 * Part A of the diary as the sign dialog is shown it (`GET …/sign-preview`): what the server would freeze with a signature now, and the
 * SHA-256 of it that the sign request names (`expectedPartASha256`, backlog C2b). [partA] is the data the digest is of.
 */
export async function signPreview(request: APIRequestContext, projectId: string, day: string): Promise<{ partASha256: string; partA: Record<string, any> }> {
  const path = `/api/projects/${projectId}/reports/${day}/sign-preview`;
  const res = await request.get(path);
  expect(res.ok(), `GET ${path}: ${res.status()} ${await res.text()}`).toBeTruthy();
  return (await res.json()) as { partASha256: string; partA: Record<string, any> };
}

/**
 * Signs the entry of [day] the way a person does: looks at part A first (the preview) and names its digest in the request, so what is
 * signed is what was shown. [expectedUpdatedAt] names the version of the entry too when it is given.
 */
export async function signEntry(request: APIRequestContext, projectId: string, day: string, password: string, expectedUpdatedAt?: string): Promise<void> {
  const { partASha256 } = await signPreview(request, projectId, day);
  const path = `/api/projects/${projectId}/reports/${day}/sign`;
  const res = await request.post(path, { data: { password, expectedUpdatedAt, expectedPartASha256: partASha256 } });
  expect(res.ok(), `POST ${path}: ${res.status()} ${await res.text()}`).toBeTruthy();
}

/**
 * Chooses the option of a native `<select>` whose text contains [text], the way a person reads the list (the value is the id of a
 * person, which nobody reads). An option that is not in the list fails the step, and so does one that is `disabled`: a person cannot
 * choose it either.
 */
export async function selectByText(select: Locator, text: string | RegExp): Promise<void> {
  const option = select.locator("option").filter({ hasText: text }).first();
  await expect(option, `an option with the text ${String(text)} in the list`).toBeAttached();
  await expect(option, `the option ${String(text)} can be chosen`).toBeEnabled();
  const value = await option.getAttribute("value");
  expect(value, `the option ${String(text)} has a value`).toBeTruthy();
  await select.selectOption(value!);
}

/** The site manager of the project that is being made (the new-project page): the person with this login name. */
export async function chooseSiteManager(page: Page, nickname: string): Promise<void> {
  await selectByText(page.locator("select#siteManagerId"), nickname);
}
