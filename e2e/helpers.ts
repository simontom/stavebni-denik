import { expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";

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
