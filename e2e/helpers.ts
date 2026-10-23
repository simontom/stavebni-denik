import { expect, type Locator, type Page } from "@playwright/test";

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
