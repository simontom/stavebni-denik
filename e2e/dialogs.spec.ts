import { expect, test, type Dialog, type Locator, type Page } from "@playwright/test";
import { ADMIN_NICKNAME, ADMIN_PASSWORD } from "./global-setup";
import { selectByText } from "./helpers";

/**
 * Dialogs and controls (backlog B6). What this file pins:
 *
 *  - the application never opens one of the browser's own dialogs (`window.confirm`): every question is a dialog of its own, with
 *    the verb on the button and the safe answer in focus;
 *  - a temporary password is shown once, cannot be dismissed before it is handed over, and is gone from the page afterwards;
 *  - a dialog that holds typed text does not throw it away silently (Escape or "Zrušit" ask "Zahodit rozepsané?"), one that is
 *    saving cannot be dismissed, and a refusal of what a dialog asked for is said inside it;
 *  - a session that ends while one of these dialogs is open can be signed in again, and the dialog is still there;
 *  - the pickers of a person and a role are native `<select>`s: labelled, usable from the keyboard.
 *
 * It is written against the real server, with users and projects of its own (made through the API).
 */

const ADMIN_ID = "11111111-1111-1111-1111-111111111111";

/** What the browser's own dialogs said during the test (a `beforeunload` is the browser's, and is let through). */
let nativeDialogs: string[] = [];
test.beforeEach(({ page }) => {
  nativeDialogs = [];
  page.on("dialog", async (dialog: Dialog) => {
    if (dialog.type() === "beforeunload") return void (await dialog.accept());
    nativeDialogs.push(`${dialog.type()}: ${dialog.message()}`);
    await dialog.dismiss();
  });
});
test.afterEach(() => {
  expect(nativeDialogs, "the application opened one of the browser's own dialogs").toEqual([]);
});

async function login(page: Page) {
  await page.goto("/login");
  await page.locator('input[name="nickname"]').fill(ADMIN_NICKNAME);
  await page.locator('input[name="password"]').fill(ADMIN_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 });
}

interface Made {
  id: string;
  nickname: string;
  displayName: string;
}

/** A user of its own, made through the API (the page under test is the one that changes it). */
async function makeUser(page: Page, label: string): Promise<Made> {
  const nickname = `e2e-dlg-${label}-${Date.now()}`;
  const displayName = `Dialog ${label}`;
  const res = await page.request.post("/api/users", { data: { nickname, displayName, role: "WORKER" } });
  expect(res.ok(), await res.text()).toBeTruthy();
  const body = (await res.json()) as { user: { id: string } };
  return { id: body.user.id, nickname, displayName };
}

/** Takes the user away again, so the list of users the other specs read does not grow with every run. */
async function dropUser(page: Page, user: Made) {
  await page.request.delete(`/api/users/${user.id}`).catch(() => undefined);
}

const rowOf = (page: Page, user: Made) => page.locator("tr", { hasText: user.nickname });

/** The temporary password a one-time dialog shows. */
async function passwordIn(dialog: Locator): Promise<string> {
  const password = (await dialog.getByTestId("one-time-password").innerText()).trim();
  expect(password.length, "a generated password").toBeGreaterThanOrEqual(12);
  return password;
}

/** A project of its own (the administrator is its site manager), made through the API. */
async function makeProject(page: Page): Promise<string> {
  const res = await page.request.post("/api/projects", {
    data: {
      name: `E2E Dialogs ${Date.now()}`,
      address: "E2E Street 1",
      cadastralArea: "E2E Area",
      parcelNumbers: "1/1",
      builder: "Builder a.s.",
      contractor: "Contractor s.r.o.",
      siteManagerId: ADMIN_ID,
    },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  return ((await res.json()) as { id: string }).id;
}

/**
 * The rule every dialog with typed text follows: an untouched one closes at once; one with text asks "Zahodit rozepsané?" on
 * Escape and on "Zrušit", keeps the text when the person writes on, and throws it away (and gives the focus back to what opened
 * the dialog) only when the person says so.
 */
async function expectAsksBeforeDiscarding(page: Page, { opener, dialog, field, typed }: { opener: Locator; dialog: Locator; field: Locator; typed: string }) {
  const ask = page.getByRole("dialog", { name: "Zahodit rozepsané?" });
  const original = await field.inputValue();

  // Untouched: Escape closes it, no question, and the focus is back on the opener
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(ask).toHaveCount(0);
  await expect(opener).toBeFocused();

  // Typed: Escape asks, and the dialog with its text is still there under the question
  await opener.click();
  await field.fill(typed);
  await page.keyboard.press("Escape");
  await expect(ask).toBeVisible();
  await expect(ask.getByRole("button", { name: "Psát dál" }), "the safe answer is in focus").toBeFocused();
  await expect(dialog).toBeVisible();

  // Escape on the question is "write on": the text is there, and the focus is where it was
  await page.keyboard.press("Escape");
  await expect(ask).toHaveCount(0);
  await expect(field).toHaveValue(typed);
  await expect(field).toBeFocused();

  // "Zrušit" asks too, and "Psát dál" gives the focus back to the button that was used
  const cancel = dialog.getByRole("button", { name: "Zrušit", exact: true });
  await cancel.click();
  await expect(ask).toBeVisible();
  await ask.getByRole("button", { name: "Psát dál" }).click();
  await expect(ask).toHaveCount(0);
  await expect(cancel).toBeFocused();
  await expect(field).toHaveValue(typed);

  // The person says so: both are gone, the focus is back on the opener, and the text really is gone
  await cancel.click();
  await ask.getByRole("button", { name: "Zahodit", exact: true }).click();
  await expect(ask).toHaveCount(0);
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
  await opener.click();
  await expect(field).toHaveValue(original);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
}

// --- The temporary password ------------------------------------------------------------------------------------------

test("a new account's temporary password is shown once: it cannot be dismissed before it is handed over, and is gone from the page afterwards", async ({ page, request }) => {
  test.setTimeout(90_000);
  await login(page);
  await page.goto("/admin/users");
  const nickname = `e2e-dlg-new-${Date.now()}`;
  const openCreate = page.getByRole("button", { name: "Nový uživatel" });
  await openCreate.click();
  const form = page.getByRole("dialog", { name: "Vytvořit nového uživatele" });
  await form.getByLabel("Přihlašovací jméno (nickname)").fill(nickname);
  await form.getByLabel("Jméno a příjmení (displayName)").fill("Dialog Nový");
  await form.getByRole("button", { name: "Vytvořit", exact: true }).click();

  const shown = page.getByRole("dialog", { name: "Uživatel byl vytvořen" });
  await expect(shown).toBeVisible({ timeout: 15_000 });
  await expect(form).toHaveCount(0);
  const password = await passwordIn(shown);
  await expect(shown).toContainText(nickname);

  // Not dismissible: no button to press, Escape and a click beside the dialog do nothing
  const done = shown.getByRole("button", { name: "Hotovo" });
  await expect(done).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(shown).toBeVisible();
  await page.mouse.click(4, 4);
  await expect(shown).toBeVisible();
  expect(await page.content(), "the password is shown while it is not handed over").toContain(password);

  // The password is what the person can really sign in with
  const signedIn = await request.post("/api/auth/login", { data: { nickname, password } });
  expect(signedIn.ok(), "the shown password is the account's").toBeTruthy();

  await shown.getByLabel("Heslo jsem předal(a)").check();
  await expect(done).toBeEnabled();
  await done.click();
  await expect(shown).toHaveCount(0);
  expect(await page.content(), "the password is gone from the page").not.toContain(password);
  await expect(openCreate).toBeFocused();

  const created = (await (await page.request.get("/api/users")).json()) as { id: string; nickname: string }[];
  const mine = created.find((u) => u.nickname === nickname);
  expect(mine, "the account exists").toBeTruthy();
  await dropUser(page, { id: mine!.id, nickname, displayName: "Dialog Nový" });
});

test("an administrator's reset asks first with the safe answer in focus, and shows the new password once", async ({ page, request }) => {
  test.setTimeout(90_000);
  await login(page);
  const user = await makeUser(page, "reset");
  try {
    await page.goto("/admin/users");
    const opener = rowOf(page, user).getByRole("button", { name: "Obnovit heslo", exact: true });
    await opener.click();
    const ask = page.getByRole("dialog", { name: "Obnovit heslo?" });
    await expect(ask).toBeVisible();
    await expect(ask).toContainText(user.nickname);
    await expect(ask.getByRole("button", { name: "Zrušit", exact: true }), "the safe answer is in focus").toBeFocused();

    // Escape is "no": nothing happened, and the focus is back on the button that asked
    await page.keyboard.press("Escape");
    await expect(ask).toHaveCount(0);
    await expect(opener).toBeFocused();

    await opener.click();
    await ask.getByRole("button", { name: "Obnovit heslo", exact: true }).click();
    const shown = page.getByRole("dialog", { name: "Heslo bylo obnoveno" });
    await expect(shown).toBeVisible({ timeout: 15_000 });
    await expect(ask).toHaveCount(0);
    const password = await passwordIn(shown);
    const signedIn = await request.post("/api/auth/login", { data: { nickname: user.nickname, password } });
    expect(signedIn.ok(), "the shown password is the account's").toBeTruthy();

    // Not before it is handed over; after that Escape is enough
    await page.keyboard.press("Escape");
    await expect(shown).toBeVisible();
    await shown.getByLabel("Heslo jsem předal(a)").check();
    await page.keyboard.press("Escape");
    await expect(shown).toHaveCount(0);
    await expect(opener).toBeFocused();
    expect(await page.content(), "the password is gone from the page").not.toContain(password);
  } finally {
    await dropUser(page, user);
  }
});

// --- Questions -------------------------------------------------------------------------------------------------------

test("deactivating, activating and deleting a user ask in the application's own dialog, with the verb on the button", async ({ page }) => {
  test.setTimeout(90_000);
  await login(page);
  const user = await makeUser(page, "ask");
  try {
    await page.goto("/admin/users");
    const row = rowOf(page, user);
    const deactivate = row.getByRole("button", { name: "Deaktivovat", exact: true });

    // "Zrušit" changes nothing
    await deactivate.click();
    const ask = page.getByRole("dialog", { name: "Deaktivovat uživatele?" });
    await expect(ask).toContainText(user.nickname);
    await expect(ask.getByRole("button", { name: "Zrušit", exact: true })).toBeFocused();
    await ask.getByRole("button", { name: "Zrušit", exact: true }).click();
    await expect(ask).toHaveCount(0);
    await expect(row.getByText("Aktivní")).toBeVisible();
    await expect(deactivate).toBeFocused();

    // The verb does it, and the focus stays on the button that asked
    await deactivate.click();
    await ask.getByRole("button", { name: "Deaktivovat", exact: true }).click();
    await expect(row.getByText("Deaktivován")).toBeVisible({ timeout: 15_000 });
    await expect(ask).toHaveCount(0);
    const activate = row.getByRole("button", { name: "Aktivovat", exact: true });
    await expect(activate).toBeFocused();

    await activate.click();
    await page.getByRole("dialog", { name: "Aktivovat uživatele?" }).getByRole("button", { name: "Aktivovat", exact: true }).click();
    await expect(row.getByText("Aktivní")).toBeVisible({ timeout: 15_000 });

    await row.getByRole("button", { name: "Smazat", exact: true }).click();
    const del = page.getByRole("dialog", { name: "Smazat uživatele?" });
    await expect(del).toContainText(user.nickname);
    await expect(del.getByRole("button", { name: "Zrušit", exact: true })).toBeFocused();
    await del.getByRole("button", { name: "Smazat", exact: true }).click();
    await expect(rowOf(page, user)).toHaveCount(0, { timeout: 15_000 });
  } finally {
    await dropUser(page, user);
  }
});

test("revoking an authorised person asks first, says it cannot be taken back, and keeps the person when the answer is no", async ({ page }) => {
  test.setTimeout(90_000);
  await login(page);
  const projectId = await makeProject(page);
  const person = `Ing. Zrušený ${Date.now()}`;
  const added = await page.request.post(`/api/projects/${projectId}/authorized-persons`, { data: { name: person, company: "Firma s.r.o.", authorization: "Dozor" } });
  expect(added.ok(), await added.text()).toBeTruthy();

  await page.goto(`/projects/${projectId}?tab=members`);
  const opener = page.getByRole("button", { name: `Zrušit ${person}` });
  await opener.click();
  const ask = page.getByRole("dialog", { name: "Zrušit pověření?" });
  await expect(ask).toContainText(person);
  await expect(ask).toContainText(/nejde vzít zpět/i);
  await expect(ask.getByRole("button", { name: "Ponechat", exact: true }), "the safe answer is in focus").toBeFocused();
  await page.keyboard.press("Escape");
  await expect(ask).toHaveCount(0);
  await expect(opener).toBeFocused();
  await expect(page.getByText("Zrušeno", { exact: true })).toHaveCount(0);

  await opener.click();
  await ask.getByRole("button", { name: "Zrušit pověření", exact: true }).click();
  await expect(page.getByText("Zrušeno", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(ask).toHaveCount(0);
});

// --- Typed text, saving and refusals ---------------------------------------------------------------------------------

test("the dialogs that hold typed text (edit a user, create a user, add an authorised person) ask before they throw it away", async ({ page }) => {
  test.setTimeout(120_000);
  await login(page);
  const user = await makeUser(page, "discard");
  try {
    await page.goto("/admin/users");
    const edit = page.getByRole("dialog", { name: "Upravit uživatele" });
    const editOpener = rowOf(page, user).getByRole("button", { name: "Upravit", exact: true });
    await editOpener.click();
    await expectAsksBeforeDiscarding(page, { opener: editOpener, dialog: edit, field: edit.getByLabel("Jméno a příjmení"), typed: "Rozepsané jméno" });

    const create = page.getByRole("dialog", { name: "Vytvořit nového uživatele" });
    const createOpener = page.getByRole("button", { name: "Nový uživatel" });
    await createOpener.click();
    await expectAsksBeforeDiscarding(page, { opener: createOpener, dialog: create, field: create.getByLabel("Přihlašovací jméno (nickname)"), typed: "rozepsane-jmeno" });
  } finally {
    await dropUser(page, user);
  }

  const projectId = await makeProject(page);
  await page.goto(`/projects/${projectId}?tab=members`);
  const add = page.getByRole("dialog", { name: "Přidat pověřenou osobu" });
  const addOpener = page.getByRole("button", { name: "Přidat osobu" });
  await addOpener.click();
  await expectAsksBeforeDiscarding(page, { opener: addOpener, dialog: add, field: add.getByLabel("Jméno a příjmení / Titul"), typed: "Ing. Rozepsaný" });
});

test("a dialog that is saving cannot be dismissed, and what the server refuses is said inside the dialog", async ({ page }) => {
  test.setTimeout(90_000);
  await login(page);
  const user = await makeUser(page, "refuse");
  try {
    await page.goto("/admin/users");
    const opener = rowOf(page, user).getByRole("button", { name: "Upravit", exact: true });
    await opener.click();
    const edit = page.getByRole("dialog", { name: "Upravit uživatele" });
    const name = edit.getByLabel("Jméno a příjmení");
    await name.fill("x".repeat(201));

    // While the request is under way Escape and "Zrušit" do nothing
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route("**/api/users/*", async (route) => {
      if (route.request().method() === "PATCH") await held;
      await route.continue();
    });
    await edit.getByRole("button", { name: "Uložit změny" }).click();
    await expect(edit.getByRole("button", { name: "Zrušit", exact: true })).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(edit).toBeVisible();
    await expect(page.getByRole("dialog", { name: "Zahodit rozepsané?" })).toHaveCount(0);
    release();

    // The server refuses (200 characters at most): said in the dialog, which stays open with the text, and not on the page behind it
    await expect(edit.getByRole("alert")).toContainText(/nejvýše 200 znaků/, { timeout: 15_000 });
    await expect(edit).toBeVisible();
    await expect(name).toHaveValue("x".repeat(201));
    await expect(page.locator("main [role=alert]:not(dialog [role=alert])"), "the refusal is not shown on the page behind the dialog").toHaveCount(0);
    await expect(edit.getByRole("button", { name: "Uložit změny" }), "the person can try again").toBeEnabled();
    await page.unroute("**/api/users/*");

    // The same in a question: an account cannot delete itself, and the dialog says so and stays
    await page.keyboard.press("Escape");
    await page.getByRole("dialog", { name: "Zahodit rozepsané?" }).getByRole("button", { name: "Zahodit", exact: true }).click();
    await expect(edit).toHaveCount(0);
    await page.locator("tr", { hasText: ADMIN_NICKNAME }).first().getByRole("button", { name: "Smazat", exact: true }).click();
    const ask = page.getByRole("dialog", { name: "Smazat uživatele?" });
    await ask.getByRole("button", { name: "Smazat", exact: true }).click();
    await expect(ask.getByRole("alert")).toContainText(/nelze smazat vlastní účet/i, { timeout: 15_000 });
    await expect(ask).toBeVisible();
    await ask.getByRole("button", { name: "Zrušit", exact: true }).click();
    await expect(ask).toHaveCount(0);
  } finally {
    await dropUser(page, user);
  }
});

test("the dialog that adds an authorised person says what the server refuses inside itself", async ({ page }) => {
  await login(page);
  const projectId = await makeProject(page);
  await page.goto(`/projects/${projectId}?tab=members`);
  await page.getByRole("button", { name: "Přidat osobu" }).click();
  const add = page.getByRole("dialog", { name: "Přidat pověřenou osobu" });
  await add.getByRole("button", { name: "Uložit", exact: true }).click();
  await expect(add.getByRole("alert")).toBeVisible({ timeout: 15_000 });
  await expect(add).toBeVisible();
  await expect(page.locator("main [role=alert]:not(dialog [role=alert])")).toHaveCount(0);
});

// --- A session that ends while a dialog is open ----------------------------------------------------------------------

test("a session that ends while a form dialog or a question is open can be signed in again, and the dialog is still there", async ({ page }) => {
  test.setTimeout(120_000);
  await login(page);
  const user = await makeUser(page, "lapse");
  try {
    await page.goto("/admin/users");
    const expired = page.getByRole("dialog", { name: /přihlášení vypršelo/i });
    const signInAgain = async () => {
      await expired.getByLabel("Heslo").fill(ADMIN_PASSWORD);
      await expired.getByRole("button", { name: /přihlásit se/i }).click();
      await expect(expired).toBeHidden({ timeout: 15_000 });
    };

    // A form dialog with typed text
    await rowOf(page, user).getByRole("button", { name: "Upravit", exact: true }).click();
    const edit = page.getByRole("dialog", { name: "Upravit uživatele" });
    await edit.getByLabel("Jméno a příjmení").fill("Přepsané jméno");
    await page.context().clearCookies();
    await edit.getByRole("button", { name: "Uložit změny" }).click();
    await expect(expired).toBeVisible({ timeout: 15_000 });
    await signInAgain();
    await expect(edit).toBeVisible();
    await expect(edit.getByLabel("Jméno a příjmení")).toHaveValue("Přepsané jméno");
    await edit.getByRole("button", { name: "Uložit změny" }).click();
    await expect(edit).toHaveCount(0, { timeout: 15_000 });
    await expect(rowOf(page, user).getByText("Přepsané jméno")).toBeVisible();

    // A question: the answer is refused, the dialog is still there, and the same answer works after signing in
    await rowOf(page, user).getByRole("button", { name: "Obnovit heslo", exact: true }).click();
    const ask = page.getByRole("dialog", { name: "Obnovit heslo?" });
    await page.context().clearCookies();
    await ask.getByRole("button", { name: "Obnovit heslo", exact: true }).click();
    await expect(expired).toBeVisible({ timeout: 15_000 });
    await signInAgain();
    await expect(ask).toBeVisible();
    await ask.getByRole("button", { name: "Obnovit heslo", exact: true }).click();
    const shown = page.getByRole("dialog", { name: "Heslo bylo obnoveno" });
    await expect(shown).toBeVisible({ timeout: 15_000 });
    await shown.getByLabel("Heslo jsem předal(a)").check();
    await shown.getByRole("button", { name: "Hotovo" }).click();
    await expect(shown).toHaveCount(0);
  } finally {
    await dropUser(page, user);
  }
});

// --- The pickers -----------------------------------------------------------------------------------------------------

test("the site manager is picked in a native select: labelled, usable from the keyboard, and a person without a ČKAIT number is listed but cannot be chosen", async ({ page }) => {
  await login(page);
  await page.goto("/projects/new");
  const select = page.getByLabel("Hlavní stavbyvedoucí");
  await expect(select).toBeVisible({ timeout: 15_000 });
  expect(await select.evaluate((el) => el.tagName), "a native select, not a button with a list").toBe("SELECT");

  // The creator holds a number, so they are the usual choice and are chosen at the start
  await expect(select).toHaveValue(ADMIN_ID);

  // A person without a number is in the list, cannot be chosen, and the reason is in the text and under the field
  const worker = select.locator("option", { hasText: "worker@stavebni-denik.cz" });
  await expect(worker).toBeDisabled();
  await expect(worker).toContainText("bez čísla ČKAIT");
  await expect(select).toHaveAccessibleDescription(/osoby bez čísla ČKAIT jsou v seznamu, ale nelze je vybrat/i);
  const hint = page.locator(`[id="${(await select.getAttribute("aria-describedby"))!.split(" ")[0]}"]`);
  const [selectBox, hintBox] = [(await select.boundingBox())!, (await hint.boundingBox())!];
  expect(hintBox.y, "the hint is under the field").toBeGreaterThan(selectBox.y + selectBox.height - 1);

  // From the keyboard: the arrows move through the people who can be chosen and never land on one who cannot
  const chosen = await select.evaluate((el: HTMLSelectElement) =>
    Array.from(el.options)
      .filter((o) => !o.disabled && o.value)
      .map((o) => o.value),
  );
  expect(chosen.length, "at least two people can be chosen").toBeGreaterThanOrEqual(2);
  await select.focus();
  for (const key of ["ArrowDown", "ArrowDown", "ArrowDown", "ArrowUp", "ArrowUp", "ArrowUp", "ArrowUp"]) {
    await page.keyboard.press(key);
    const value = await select.inputValue();
    expect(value === "" || chosen.includes(value), `${key} landed on ${value}`).toBeTruthy();
  }
});

test("a member and a role are picked in native selects, and a person without a ČKAIT number cannot be made a manager", async ({ page }) => {
  test.setTimeout(90_000);
  await login(page);
  const projectId = await makeProject(page);
  await page.goto(`/projects/${projectId}?tab=members`);
  const who = page.getByLabel("Uživatel", { exact: true });
  const role = page.getByLabel("Role v projektu");
  await expect(who).toBeVisible({ timeout: 15_000 });
  expect(await who.evaluate((el) => el.tagName)).toBe("SELECT");
  expect(await role.evaluate((el) => el.tagName)).toBe("SELECT");

  await selectByText(who, "e2e-investor");
  await expect(role, "the person's own role is the one offered").toHaveValue("INVESTOR");
  await page.getByRole("button", { name: "Přidat", exact: true }).click();
  await expect(page.locator("table").getByText("e2e-investor")).toBeVisible({ timeout: 15_000 });

  // The role is changed from the keyboard, and a manager needs a number
  await selectByText(who, "worker@stavebni-denik.cz");
  await role.selectOption("BOSS");
  await expect(page.getByRole("status").filter({ hasText: /nemá číslo ČKAIT/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Přidat", exact: true })).toBeDisabled();
  await role.selectOption("WORKER");
  await expect(page.getByRole("button", { name: "Přidat", exact: true })).toBeEnabled();
});
