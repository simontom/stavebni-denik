import { expect, test } from "@playwright/test";
import { ADMIN_NICKNAME, ADMIN_PASSWORD, INVESTOR_NICKNAME, INVESTOR_PASSWORD } from "./global-setup";

test.describe("Legislative Compliance", () => {
  test("complete flow: legislative fields, site handovers signed by both parties, authorized persons, and investor acknowledgment", async ({ page }) => {
    test.setTimeout(180_000);

    // 1. Login as BOSS (admin)
    await page.goto("/login");
    await page.locator('input[name="nickname"]').fill(ADMIN_NICKNAME);
    await page.locator('input[name="password"]').fill(ADMIN_PASSWORD);
    await page.getByRole("button", { name: /přihlásit se/i }).click();
    await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 });

    // 2. Create Project with legislative fields
    await page.goto("/projects/new");
    await page.locator('input[name="name"]').fill("Legislative Project");
    await page.locator('input[name="address"]').fill("Leg 1");
    await page.locator('input[name="cadastralArea"]').fill("Leg Area");
    await page.locator('input[name="parcelNumbers"]').fill("123");
    await page.locator('input[name="builder"]').fill("B");
    await page.locator('input[name="contractor"]').fill("C");
    await page.locator('button[id="siteManagerId"]').click();
    await page.getByRole("option", { name: new RegExp(ADMIN_NICKNAME) }).click();

    await page.locator('input[name="contractNumber"]').fill("SML-123");
    await page.locator('input[name="contractDate"]').fill("2026-09-01");
    await page.locator('input[name="designDocVersion"]').fill("v1.2");
    await page.locator('input[name="designDocDate"]').fill("2026-08-15");

    await page.getByRole("button", { name: /založit/i }).click();

    // 3. Verify Project Details
    await expect(page).toHaveURL(/\/projects\/.+/);
    await expect(page.getByText("SML-123")).toBeVisible();
    await expect(page.getByText("v1.2")).toBeVisible();

    // 4. Test Site Handovers (Předání staveniště): a protocol is signed by both parties, one signature each (backlog A3)
    const projectUrl = page.url().split("?")[0];
    const projectId = projectUrl.split("/projects/")[1];
    await page.getByRole("link", { name: /Předání staveniště/i }).click();
    const addButton = page.getByRole("button", { name: /Přidat předání/i });
    await addButton.click();

    const form = page.getByRole("dialog", { name: /Protokol o předání staveniště/i });
    // Escape closes the dialog, and the focus is back on the button that opened it
    await expect(form).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(form).toBeHidden();
    await expect(addButton).toBeFocused();
    await addButton.click();
    await form.locator('input[id="handover-type"]').fill("Předání staveniště zhotoviteli");
    await form.locator('input[id="handover-date"]').fill("2026-09-11");
    await form.locator('input[id="handover-participants"]').fill("Ing. Jan Novák (objednatel), Petr Svoboda (zhotovitel)");

    await form.getByRole("button", { name: /Přidat měřidlo/i }).click();
    await form.locator('input[placeholder*="Médium"]').fill("Elektřina VT");
    await form.locator('input[placeholder*="Výrobní číslo"]').fill("EL-98765");
    await form.locator('input[placeholder*="Stav"]').fill("12450 kWh");

    await form.locator('textarea[id="handover-notes"]').fill("Staveniště předáno bez výhrad.");

    await form.getByRole("button", { name: /Uložit předání/i }).click();
    await expect(form).toBeHidden();
    await expect(addButton).toBeFocused();

    // Verify record in list: a draft that neither party has signed
    await expect(page.getByText("Předání staveniště zhotoviteli")).toBeVisible();
    await expect(page.getByText("Ing. Jan Novák (objednatel), Petr Svoboda (zhotovitel)")).toBeVisible();
    await expect(page.getByText("Elektřina VT")).toBeVisible();
    await expect(page.getByText("12450 kWh")).toBeVisible();
    await expect(page.getByText("Rozpracováno, čeká na podpisy")).toBeVisible();
    await expect(page.getByText("Čeká na podpis", { exact: true })).toHaveCount(2);

    // Until a party has signed the protocol can be changed (the change carries the version it was loaded in)
    const editButton = page.getByRole("button", { name: "Upravit", exact: true });
    await editButton.click();
    const edit = page.getByRole("dialog", { name: /Upravit protokol o předání staveniště/i });
    await expect(edit).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(edit).toBeHidden();
    await expect(editButton).toBeFocused();
    await editButton.click();
    await edit.locator('textarea[id="handover-notes"]').fill("Staveniště předáno bez výhrad, klíče od vrat předány.");
    await edit.getByRole("button", { name: /Uložit předání/i }).click();
    // (a typed text is also the text of its own textarea, so wait for the dialog to go before looking at the list)
    await expect(edit).toBeHidden();
    await expect(editButton).toBeFocused();
    await expect(page.getByText("klíče od vrat předány")).toBeVisible();

    // Somebody else changes the protocol after this page loaded it: signing the version on the screen is refused, and the page says so
    const listed = await page.request.get(`/api/projects/${projectId}/handovers`);
    expect(listed.ok()).toBeTruthy();
    const [stored] = (await listed.json()) as { id: string; type: string; date: string; participants: string; notes: string; updatedAt: string }[];
    const changed = await page.request.put(`/api/handovers/${stored.id}`, {
      data: { type: stored.type, date: stored.date, participants: stored.participants, notes: "Změněno jinou osobou.", expectedUpdatedAt: stored.updatedAt },
    });
    expect(changed.ok(), await changed.text()).toBeTruthy();
    await page.getByRole("button", { name: "Podepsat za zhotovitele" }).click();
    const staleSign = page.getByRole("dialog", { name: /Podepsat předání za zhotovitele/i });
    await staleSign.getByLabel("Heslo").fill(ADMIN_PASSWORD);
    await staleSign.getByRole("button", { name: "Podepsat", exact: true }).click();
    await expect(page.getByText(/mezitím změnil někdo jiný/i)).toBeVisible();
    await expect(page.getByText("Rozpracováno, čeká na podpisy")).toBeVisible();
    await page.getByRole("button", { name: "Načíst aktuální stav" }).click();
    await expect(page.getByText("Změněno jinou osobou.")).toBeVisible();

    // The manager signs for the contractor. Escape leaves the focus on the button that was used, and nothing typed is kept: the
    // password field is empty when the dialog is opened again.
    const signButton = page.getByRole("button", { name: "Podepsat za zhotovitele" });
    await signButton.click();
    const sign = page.getByRole("dialog", { name: /Podepsat předání za zhotovitele/i });
    await sign.getByLabel("Heslo").fill("Neodeslane-Heslo-1!");
    await page.keyboard.press("Escape");
    await expect(sign).toBeHidden();
    await expect(signButton).toBeFocused();
    await signButton.click();
    await expect(sign.getByLabel("Heslo")).toHaveValue("");
    // A wrong password is told in the dialog, which stays open; the right one signs
    await sign.getByLabel("Heslo").fill("Spatne-Heslo-123!");
    await sign.getByRole("button", { name: "Podepsat", exact: true }).click();
    await expect(sign.getByText("Heslo není správné")).toBeVisible();
    await sign.getByLabel("Heslo").fill(ADMIN_PASSWORD);
    await sign.getByRole("button", { name: "Podepsat", exact: true }).click();

    await expect(page.getByText("Podepsal zhotovitel, čeká na stavebníka")).toBeVisible();
    // The button that was used is gone (its side is signed), so the focus is on the protocol that changed
    await expect(page.locator(`#handover-${stored.id}`)).toBeFocused();
    await expect(page.getByText(/Podepsal\(a\) E2E Admin \(Stavbyvedoucí, ČKAIT 0000000\)/)).toBeVisible();
    await expect(page.getByText(/Otisk obsahu \(SHA-256\): [0-9a-f]{64}/)).toBeVisible();
    // From the first signature the protocol is a document: nothing to change, and the contractor's side cannot be signed again
    await expect(page.getByRole("button", { name: "Upravit", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Podepsat za/ })).toHaveCount(0);
    await expect(page.getByText("Čeká na podpis", { exact: true })).toHaveCount(1);

    // 5. Test Authorized Persons (Pověřené osoby)
    await page.getByRole("link", { name: /Členové/i }).click();
    await expect(page.getByText("Seznam pověřených osob")).toBeVisible();

    await page.getByRole("button", { name: /Přidat osobu/i }).click();
    await page.locator('input[id="person-name"]').fill("Ing. Arch. Petr Černý");
    await page.locator('input[id="person-company"]').fill("Architekti s.r.o.");
    await page.locator('input[id="person-auth"]').fill("Autorský dozor projektanta");
    await page.getByRole("button", { name: /^Uložit$/i }).click();

    await expect(page.getByText("Ing. Arch. Petr Černý").first()).toBeVisible();
    await expect(page.getByText("Architekti s.r.o.")).toBeVisible();
    await expect(page.getByText("Autorský dozor projektanta")).toBeVisible();

    // Revoke external person
    page.once("dialog", (d) => d.accept());
    await page.getByRole("button", { name: /Zrušit Ing. Arch. Petr Černý/i }).click();
    await expect(page.getByText("Zrušeno", { exact: true })).toBeVisible();

    // 6. Add Investor as project member
    const userSelect = page.locator('button[data-slot="select-trigger"]').first();
    await userSelect.click();
    await page.getByRole("option", { name: new RegExp(INVESTOR_NICKNAME) }).click();

    const roleSelect = page.locator('button[data-slot="select-trigger"]').nth(1);
    await roleSelect.click();
    await page.getByRole("option", { name: /Investor/i }).click();

    await page.getByRole("button", { name: /Přidat$/i }).click();
    await expect(page.locator("table").getByText(INVESTOR_NICKNAME)).toBeVisible();

    // 7. Create Daily Report with Control Day and SO
    await page.getByRole("link", { name: /^Záznamy$/i }).click();
    // Today in Prague: an earlier day would be a late entry and would need a reason.
    await page.locator('input[id="new-report-date"]').fill(new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Prague" }).format(new Date()));
    await page.getByRole("button", { name: /otevřít den/i }).click();

    await expect(page).toHaveURL(/\/projects\/.+\/reports\/.+/);
    await page.locator('input[name="isControlDay"]').check();
    await page.locator('input[name="constructionObj"]').fill("SO-101");
    await page.locator('textarea[name="workDescription"]').fill("Práce na SO-101");
    await page.getByRole("button", { name: /uložit (záznam|změny)/i }).click();

    // Verify badges
    await expect(page.getByText("Kontrolní den")).toBeVisible();
    await expect(page.getByText("SO: SO-101")).toBeVisible();
    const reportUrl = page.url();

    // The report must be signed (and locked) before an investor can acknowledge it.
    await page.getByRole("button", { name: /podepsat a uzamknout/i }).click();
    const signDialog = page.getByRole("dialog", { name: /podepsat a uzamknout záznam/i });
    await signDialog.getByLabel("Heslo").fill(ADMIN_PASSWORD);
    await signDialog.getByRole("button", { name: "Podepsat", exact: true }).click();
    await expect(page.getByText("Podepsáno", { exact: true })).toBeVisible();

    // 8. Log in as INVESTOR and acknowledge report
    await page.context().clearCookies();
    await page.goto("/login");
    await page.locator('input[name="nickname"]').fill(INVESTOR_NICKNAME);
    await page.locator('input[name="password"]').fill(INVESTOR_PASSWORD);
    await page.getByRole("button", { name: /přihlásit se/i }).click();
    await expect(page).not.toHaveURL(/\/login/);

    // The client signs the other side of the handover: the same dialog, the investor's own password, no ČKAIT number
    await page.goto(`${projectUrl}?tab=handovers`);
    await expect(page.getByText("Podepsal zhotovitel, čeká na stavebníka")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: "Upravit", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Podepsat za zhotovitele" })).toHaveCount(0);
    await page.getByRole("button", { name: "Podepsat za stavebníka" }).click();
    const clientSign = page.getByRole("dialog", { name: /Podepsat předání za stavebníka/i });
    await clientSign.getByLabel("Heslo").fill(INVESTOR_PASSWORD);
    await clientSign.getByRole("button", { name: "Podepsat", exact: true }).click();
    await expect(page.getByText("Podepsáno oběma stranami")).toBeVisible();
    await expect(page.getByText(/Podepsal\(a\) E2E Investor \(Investor\), /)).toBeVisible();
    await expect(page.getByRole("button", { name: /Podepsat za/ })).toHaveCount(0);

    // Go to report
    await page.goto(reportUrl);
    await expect(page.getByText("Kontrolní den")).toBeVisible();
    await expect(page.getByText("SO: SO-101")).toBeVisible();

    // Verify investor CANNOT edit or sign as boss
    await expect(page.getByRole("link", { name: /upravit/i })).not.toBeVisible();
    await expect(page.getByRole("button", { name: /podepsat záznam/i })).not.toBeVisible();

    // Verify investor sees and can click Acknowledge button
    const ackBtn = page.getByRole("button", { name: /potvrdit seznámení/i });
    await expect(ackBtn).toBeVisible();

    page.once("dialog", (d) => d.accept());
    await ackBtn.click();

    // Verify acknowledged status appears in header
    await expect(page.getByText(/Seznámil\(a\) se: .*\(stavebník\)/)).toBeVisible();
    await expect(ackBtn).not.toBeVisible();

    // An investor reads the daily entry but does not write it: an unsigned day is shown locked, without a save button.
    const yesterday = new Date(`${new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Prague" }).format(new Date())}T00:00:00Z`);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    await page.goto(reportUrl.replace(/\/reports\/.*$/, `/reports/${yesterday.toISOString().slice(0, 10)}`));
    await expect(page.getByText(/můžete jen číst/i)).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('textarea[name="workDescription"]')).toBeDisabled();
    await expect(page.getByRole("button", { name: /uložit (záznam|změny)/i })).toHaveCount(0);
  });
});
