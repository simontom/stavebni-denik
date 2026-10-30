import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { ADMIN_NICKNAME, ADMIN_PASSWORD } from "./global-setup";
import { signEntry } from "./helpers";

/**
 * The words of the interface and the accessibility of the forms (backlog B7, C1): one glossary applied everywhere, a `<title>` for every
 * page, labels and messages tied to their fields on every form, the login form with visible labels. The data is made through the API
 * (a project of its own, named for the run), so the test reads what it made.
 */

const INVESTOR_ID = "22222222-2222-2222-2222-222222222222";
const WORKER_ID = "55555555-5555-5555-5555-555555555555";
const DAY = "2026-09-28";
const DAY_CZ = "28. 9. 2026";
const APP = "Stavební deník";

async function signIn(page: Page) {
  await page.goto("/login");
  await page.locator('input[name="nickname"]').fill(ADMIN_NICKNAME);
  await page.locator('input[name="password"]').fill(ADMIN_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 });
}

async function post<T = unknown>(api: APIRequestContext, path: string, body: unknown): Promise<T> {
  const res = await api.post(path, { data: body });
  expect(res.ok(), `POST ${path}: ${res.status()} ${await res.text()}`).toBeTruthy();
  return (await res.json()) as T;
}

/** A project of its own (the administrator is its site manager, the client and the worker are members) with a signed entry and a draft. */
async function newSite(page: Page) {
  await signIn(page);
  const admin = JSON.parse((await page.evaluate(() => localStorage.getItem("user"))) ?? "null") as { id: string };
  const projectName = `Slova ${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const project = await post<{ id: string }>(page.request, "/api/projects", {
    name: projectName,
    address: "Kotlářská 12, Brno",
    cadastralArea: "Veveří",
    parcelNumbers: "450/1",
    builder: "Statutární město Brno",
    contractor: "Stavby Morava a.s.",
    siteManagerId: admin.id,
  });
  await post(page.request, `/api/projects/${project.id}/members`, { userId: INVESTOR_ID, role: "INVESTOR" });
  await post(page.request, `/api/projects/${project.id}/members`, { userId: WORKER_ID, role: "WORKER" });
  const saved = await post<{ updatedAt: string }>(page.request, `/api/projects/${project.id}/reports/${DAY}`, {
    date: DAY,
    workDescription: "Betonáž stropní desky",
    workersByTrade: JSON.stringify([{ trade: "Zedník", count: 2 }]),
    lateEntryReason: "Doplněno dodatečně.",
    expectNew: true,
  });
  await signEntry(page.request, project.id, DAY, ADMIN_PASSWORD, saved.updatedAt);
  return { projectId: project.id, projectName };
}

/**
 * Every visible control of the page has a name a person can find (a label tied to it, or an `aria-label`), and everything it says it is
 * described by exists. Returns what is wrong, so a failure says which control.
 */
async function controlsWithoutName(page: Page, within = "body"): Promise<string[]> {
  return page.locator(within).evaluate((root) => {
    const problems: string[] = [];
    const visible = (el: Element) => {
      const box = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return box.width > 0 && box.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    for (const el of Array.from(root.querySelectorAll<HTMLInputElement>("input:not([type=hidden]), textarea, select"))) {
      if (!visible(el)) continue;
      const named = (el.labels && el.labels.length > 0) || el.getAttribute("aria-label") || el.getAttribute("aria-labelledby");
      const what = `${el.tagName.toLowerCase()}[name=${el.getAttribute("name")}][id=${el.id}]`;
      if (!named) problems.push(`${what} has no label`);
      for (const id of (el.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean)) {
        if (!document.getElementById(id)) problems.push(`${what} is described by #${id}, which does not exist`);
      }
    }
    return problems;
  });
}

test.describe("titles: every page has one of its own", () => {
  test("the login page, and every page after sign-in, by its content", async ({ page }) => {
    await page.goto("/login");
    await expect(page).toHaveTitle(`Přihlášení – ${APP}`);
    const { projectId, projectName } = await newSite(page);
    const titles = new Map<string, string>();
    const visit = async (path: string, title: string | RegExp) => {
      await page.goto(path);
      await expect(page, path).toHaveTitle(title, { timeout: 15_000 });
      titles.set(path, await page.title());
    };

    await visit("/projects", `Projekty – ${APP}`);
    await visit("/projects/new", `Nový projekt – ${APP}`);
    await visit(`/projects/${projectId}`, `${projectName} – ${APP}`);
    await visit(`/projects/${projectId}?tab=reports`, `Záznamy – ${projectName} – ${APP}`);
    await visit(`/projects/${projectId}?tab=handovers`, `Předání staveniště – ${projectName} – ${APP}`);
    await visit(`/projects/${projectId}?tab=members`, `Členové – ${projectName} – ${APP}`);
    await visit(`/projects/${projectId}/edit`, `Údaje o stavbě – ${APP}`);
    await visit(`/projects/${projectId}/reports/${DAY}`, `Záznam č. 1 / ${DAY_CZ} – ${projectName} – ${APP}`);
    await visit("/admin/users", `Uživatelé – ${APP}`);
    await visit("/admin/audit", `Audit – ${APP}`);
    await visit("/change-password", `Změna hesla – ${APP}`);

    expect(new Set(titles.values()).size, `no two pages share a title: ${JSON.stringify([...titles])}`).toBe(titles.size);
  });

  test("the title follows a navigation inside the application, and a draft is not a numbered entry", async ({ page }) => {
    const { projectId, projectName } = await newSite(page);
    await page.goto("/projects");
    await expect(page).toHaveTitle(`Projekty – ${APP}`, { timeout: 15_000 });
    await page
      .getByRole("link", { name: new RegExp(projectName) })
      .first()
      .click();
    await expect(page).toHaveTitle(`${projectName} – ${APP}`);
    await page.getByRole("link", { name: "Členové", exact: true }).click();
    await expect(page).toHaveTitle(`Členové – ${projectName} – ${APP}`);

    // an entry nobody has signed has no number: "Rozpracovaný záznam"; a day nobody has written is only "Záznam"; the signed one has its number
    await post(page.request, `/api/projects/${projectId}/reports/2026-09-29`, {
      date: "2026-09-29",
      workDescription: "Rozpracováno",
      workersByTrade: JSON.stringify([{ trade: "Zedník", count: 1 }]),
      lateEntryReason: "Doplněno dodatečně.",
      expectNew: true,
    });
    await page.goto(`/projects/${projectId}/reports/2026-09-29`);
    await expect(page).toHaveTitle(`Rozpracovaný záznam / 29. 9. 2026 – ${projectName} – ${APP}`, { timeout: 15_000 });
    await page.goto(`/projects/${projectId}/reports/2026-09-30`);
    await expect(page).toHaveTitle(`Záznam / 30. 9. 2026 – ${projectName} – ${APP}`, { timeout: 15_000 });
    await page.goto(`/projects/${projectId}/reports/${DAY}`);
    await expect(page).toHaveTitle(`Záznam č. 1 / ${DAY_CZ} – ${projectName} – ${APP}`, { timeout: 15_000 });
  });
});

test.describe("the sign-in form", () => {
  test("has visible labels, tells the browser what each field is, and announces a refusal tied to the field", async ({ page }) => {
    await page.goto("/login");
    const nickname = page.getByLabel("Přihlašovací jméno");
    const password = page.getByLabel("Heslo");
    for (const [field, label] of [
      [nickname, "Přihlašovací jméno"],
      [password, "Heslo"],
    ] as const) {
      const shown = page.locator("label", { hasText: label });
      await expect(shown, `the label ${label} is shown`).toBeVisible();
      expect((await shown.boundingBox())!.width, `the label ${label} is not a one-pixel label for screen readers only`).toBeGreaterThan(40);
      await expect(field).toBeVisible();
    }
    await expect(nickname).toHaveAttribute("autocomplete", "username");
    await expect(password).toHaveAttribute("autocomplete", "current-password");
    await expect(page.getByRole("alert")).toHaveCount(0);

    await nickname.fill("neexistuje");
    await password.fill("spatne-heslo-123");
    await page.locator('button[type="submit"]').click();
    const alert = page.getByRole("alert");
    await expect(alert).toHaveText("Neplatné přihlašovací jméno nebo heslo");
    await expect(password).toHaveAccessibleDescription("Neplatné přihlašovací jméno nebo heslo");
    expect(await controlsWithoutName(page)).toEqual([]);
  });
});

test.describe("labels and messages are tied to their fields", () => {
  test("every control of the pages with forms has a label, and what describes it exists", async ({ page }) => {
    const { projectId } = await newSite(page);
    const pages: [string, string][] = [
      ["/projects/new", "the new project"],
      [`/projects/${projectId}/edit`, "the project's identification"],
      [`/projects/${projectId}?tab=members`, "the members"],
      [`/projects/${projectId}?tab=reports`, "the entries"],
      [`/projects/${projectId}/reports/${DAY}`, "a signed entry (addenda, remarks)"],
      [`/projects/${projectId}/reports/2026-09-29`, "the form of an entry"],
      ["/admin/users", "the users"],
      ["/change-password", "the password"],
    ];
    for (const [path, what] of pages) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 }).or(page.getByRole("alert")).first(), what).toBeVisible({ timeout: 15_000 });
      // the entry form shows itself once the role is known
      if (path.includes("2026-09-29")) await expect(page.locator('textarea[name="workDescription"]')).toBeVisible({ timeout: 15_000 });
      expect(await controlsWithoutName(page, "main"), `${what}: controls without a label`).toEqual([]);
    }
  });

  test("the form of an entry: labels, hints that say what the decree asks, and the names the specs and password managers use", async ({ page }) => {
    const { projectId } = await newSite(page);
    await page.goto(`/projects/${projectId}/reports/2026-09-29`);
    await expect(page.locator('textarea[name="workDescription"]')).toBeVisible({ timeout: 15_000 });

    // the names of the fields are kept (the keys of the API and of the signature are the same words)
    for (const name of [
      "workDescription",
      "workerTrade",
      "workerCount",
      "workerNames",
      "weatherCondition",
      "weatherMin",
      "weatherMax",
      "isControlDay",
      "constructionObj",
      "detail-materials",
      "detail-machinery",
      "detail-testsAndChecks",
      "detail-safetyNotes",
      "detail-dustMeasures",
      "detail-accessibilityMeasures",
      "detail-defects",
      "detail-workStateChanges",
      "detail-otherNotes",
    ]) {
      await expect(page.locator(`[name="${name}"]`).first(), name).toBeAttached();
    }

    // příloha 12, in the words of the labels (the printed entry has the same headings)
    await expect(page.getByLabel("Dodávky materiálu, výrobků, strojů a zařízení, jejich uskladnění a zabudování")).toHaveAttribute("name", "detail-materials");
    await expect(page.getByLabel("Mechanizace", { exact: true })).toHaveAttribute("name", "detail-machinery");
    await expect(page.getByLabel("Ostatní záznamy")).toHaveAttribute("name", "detail-otherNotes");
    await expect(page.getByRole("group", { name: "Počasí a stav staveniště" })).toBeVisible();

    // what the decree asks, said where it is written: B.2 m), B.2 c) and w)
    await expect(page.getByLabel("Zkoušky, měření a kontroly")).toHaveAccessibleDescription(/souhlas se zakrytím prací/);
    const other = page.getByLabel("Ostatní záznamy");
    await expect(other).toHaveAccessibleDescription(/Nástupy, provádění prací a ukončení činností poddodavatelů/);
    await expect(other).toHaveAccessibleDescription(/§ 266 odst\. 1: čas a okolnosti nálezu, datum, kdy byl oznámen stavebnímu úřadu, a přijatá opatření/);

    // the day of an inspection has the word of the glossary, and a hint
    await expect(page.getByLabel("Kontrolní den", { exact: true })).toHaveAttribute("name", "isControlDay");
    await expect(page.getByLabel("Kontrolní den", { exact: true })).toHaveAccessibleDescription(/kontrola/);
  });

  test("a refusal that is about one control is said under it, tied to it, and the control has the focus", async ({ page }) => {
    const { projectId } = await newSite(page);
    // today in Prague: an earlier day would be a late entry, which cannot be saved without a reason
    const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Prague" }).format(new Date());
    await page.goto(`/projects/${projectId}/reports/${today}`);
    await page.locator('textarea[name="workDescription"]').fill("Zdění příček");

    // a trade with no head count
    await page.locator('input[name="workerTrade"]').first().fill("Zedník");
    await page.getByRole("button", { name: /uložit záznam/i }).click();
    const count = page.locator('input[name="workerCount"]').first();
    const alert = page.getByRole("alert").filter({ hasText: /Zadejte počet pracovníků/ });
    await expect(alert).toBeVisible();
    await expect(count).toBeFocused();
    await expect(count).toHaveAttribute("aria-invalid", "true");
    await expect(count).toHaveAccessibleDescription(/Zadejte počet pracovníků u profese "Zedník"/);
    // typing is the answer: the refusal goes away
    await count.fill("3");
    await expect(alert).toHaveCount(0);
    await expect(count).not.toHaveAttribute("aria-invalid", "true");

    // a text that is too long is its field's error, as it is typed
    const materials = page.locator('textarea[name="detail-materials"]');
    await materials.fill("x".repeat(5001));
    await expect(materials).toHaveAttribute("aria-invalid", "true");
    await expect(materials).toHaveAccessibleDescription(/Text je příliš dlouhý: 5001 \/ 5000 znaků/);
    // Save is refused: the refusal is said as an alert on its message under the field (not only the polite note of the typing), the focus
    // is on the field, and the field is described by it
    await page.getByRole("button", { name: /uložit záznam/i }).click();
    const tooLongAlert = page.getByRole("alert").filter({ hasText: /může mít nejvýše 5000 znaků \(teď 5001\)/ });
    await expect(tooLongAlert).toBeVisible();
    await expect(materials).toBeFocused();
    await expect(materials).toHaveAccessibleDescription(/může mít nejvýše 5000 znaků \(teď 5001\)/);
    // typing is the answer again: the alert goes, the polite note is back
    await materials.fill("x".repeat(5002));
    await expect(tooLongAlert).toHaveCount(0);
    await expect(materials).toHaveAccessibleDescription(/Text je příliš dlouhý: 5002 \/ 5000 znaků/);
    await materials.fill("x".repeat(4600));
    await expect(materials).not.toHaveAttribute("aria-invalid", "true");
    await expect(materials).toHaveAccessibleDescription(/4600 \/ 5000 znaků/);
  });
});

test.describe("the words of the glossary", () => {
  test("roles are in Czech wherever they are shown (members, users, the selects, the audit)", async ({ page }) => {
    const { projectId } = await newSite(page);
    // the codes of the roles (the seeded accounts have names such as "E2E Investor": data, not a label)
    const english = /\b(BOSS|WORKER|INSPECTOR|INVESTOR)\b/;
    const seen = async (what: string) => {
      const text = (await page.locator("main").innerText()) + "\n" + (await page.locator("main option").allTextContents()).join("\n");
      expect(text, `${what} shows no English role name`).not.toMatch(english);
      return text;
    };

    await page.goto(`/projects/${projectId}?tab=members`);
    await expect(page.getByRole("heading", { name: /členové/i }).first()).toBeVisible({ timeout: 15_000 });
    const members = await seen("the members");
    expect(members).toContain("Stavebník");
    expect(members).toContain("Pracovník");
    expect(members).toContain("Stavbyvedoucí");
    await expect(page.getByLabel("Role v projektu").locator("option")).toHaveText(["Stavbyvedoucí", "Pracovník", "Technický dozor", "Stavebník"]);

    await page.goto(`/projects/${projectId}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 15_000 });
    await seen("the project");

    await page.goto("/admin/users");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("table").first()).toBeVisible();
    await seen("the users");
    await page
      .getByRole("button", { name: /nový uživatel|vytvořit uživatele|přidat uživatele/i })
      .first()
      .click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByLabel("Role", { exact: true }).locator("option")).toHaveText(["Stavbyvedoucí", "Pracovník", "Technický dozor", "Stavebník"]);
    expect(await dialog.innerText(), "the dialog has no code names in brackets").not.toMatch(/\((nickname|displayName)\)/);
    await dialog.getByRole("button", { name: "Zrušit" }).click();

    // the audit says what was done in words, and keeps the code beside them
    await page.goto("/admin/audit");
    await expect(page.getByRole("heading", { level: 1, name: "Audit" })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("link", { name: "Audit", exact: true })).toBeVisible();
    await expect(page.getByRole("row", { name: /Založení projektu/ }).first()).toContainText("project.create", { timeout: 15_000 });
    await expect(page.getByRole("row", { name: /Podpis záznamu/ }).first()).toContainText("report.lock");
    expect(await page.locator("main").innerText()).not.toMatch(/Audit log|Entita/);
  });

  test("the entry page says Podepsáno once, a late entry is a late záznam, and nothing says zápis", async ({ page }) => {
    const { projectId } = await newSite(page);
    await page.goto(`/projects/${projectId}/reports/${DAY}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(/Denní záznam stavby/, { timeout: 15_000 });
    await expect(page.getByText("Podepsáno", { exact: true })).toHaveCount(1);
    await expect(page.getByRole("group", { name: "Stav záznamu" }).getByText("Pozdní záznam", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Důvod pozdního záznamu" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Počasí a stav staveniště" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Záznamy dalších osob" })).toBeVisible();

    for (const path of [`/projects/${projectId}`, `/projects/${projectId}?tab=reports`, `/projects/${projectId}/reports/${DAY}`, `/projects/${projectId}/reports/2026-09-29`]) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 15_000 });
      expect(await page.locator("body").innerText(), path).not.toMatch(/z[áÁ]pis/i);
    }
  });
});
