import { expect, test } from "@playwright/test";
import { ADMIN_NICKNAME, ADMIN_PASSWORD, INVESTOR_NICKNAME, INVESTOR_PASSWORD } from "./global-setup";
import { chooseSiteManager, selectByText } from "./helpers";

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
    await chooseSiteManager(page, ADMIN_NICKNAME);

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

    // Revoke external person: the application asks in a dialog of its own (not window.confirm), and the verb is on the button
    await page.getByRole("button", { name: /Zrušit Ing. Arch. Petr Černý/i }).click();
    await page.getByRole("dialog", { name: "Zrušit pověření?" }).getByRole("button", { name: "Zrušit pověření", exact: true }).click();
    await expect(page.getByText("Zrušeno", { exact: true })).toBeVisible();

    // 6. Add Investor as project member: two native selects, a person and a role
    await selectByText(page.getByLabel("Uživatel", { exact: true }), INVESTOR_NICKNAME);
    await page.getByLabel("Role v projektu").selectOption({ label: "Stavebník" });

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
    await expect(page.getByRole("group", { name: "Stav záznamu" }).getByText("Kontrolní den", { exact: true })).toBeVisible();
    await expect(page.getByText("SO: SO-101")).toBeVisible();
    const reportUrl = page.url();

    // The report must be signed (and locked) before an investor can acknowledge it.
    await page.getByRole("button", { name: /podepsat a uzamknout/i }).click();
    const signDialog = page.getByRole("dialog", { name: /podepsat a uzamknout záznam/i });
    await signDialog.getByLabel("Heslo").fill(ADMIN_PASSWORD);
    await signDialog.getByRole("button", { name: "Podepsat", exact: true }).click();
    await expect(page.getByText("Podepsáno", { exact: true })).toBeVisible();

    // Two things that nobody has signed, made for the contrast further down. A role is told from a document only by something that has a
    // form (an entry) or buttons (a protocol) for one role and not for the other: on the signed entry above, and on a protocol one side has
    // signed, nobody has a form or an "Upravit". So the manager looks at them here, and the client looks at the same ones below.
    const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Prague" }).format(new Date());
    const tenDaysAgo = new Date(`${today}T00:00:00Z`);
    tenDaysAgo.setUTCDate(tenDaysAgo.getUTCDate() - 10);
    const draftDay = tenDaysAgo.toISOString().slice(0, 10);
    const draftEntry = await page.request.post(`/api/projects/${projectId}/reports/${draftDay}`, {
      data: {
        date: draftDay,
        workDescription: "Rozpracováno pro stavebníka",
        workersByTrade: JSON.stringify([{ trade: "Zedník", count: 1 }]),
        lateEntryReason: "Doplněno dodatečně.",
        expectNew: true,
      },
    });
    expect(draftEntry.ok(), await draftEntry.text()).toBeTruthy();
    const unsignedHandover = await page.request.post(`/api/projects/${projectId}/handovers`, {
      data: { type: "Druhé předání", date: "2026-09-12", participants: "Obě strany", notes: "Zatím nikdo nepodepsal." },
    });
    expect(unsignedHandover.ok(), await unsignedHandover.text()).toBeTruthy();
    const unsignedHandoverId = ((await unsignedHandover.json()) as { id: string }).id;

    // The manager has the form of the draft with its save and sign buttons, and "Upravit" and the contractor's signature on the protocol.
    await page.goto(`${projectUrl}/reports/${draftDay}`);
    await expect(page.locator('textarea[name="workDescription"]')).toBeEditable({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: /uložit (záznam|změny)/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /podepsat a uzamknout/i })).toBeVisible();
    await page.goto(`${projectUrl}?tab=handovers`);
    const managersProtocol = page.locator(`#handover-${unsignedHandoverId}`);
    await expect(managersProtocol.getByRole("button", { name: "Upravit", exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(managersProtocol.getByRole("button", { name: "Podepsat za zhotovitele" })).toBeVisible();

    // 8. Log in as INVESTOR and acknowledge report
    await page.context().clearCookies();
    await page.goto("/login");
    await page.locator('input[name="nickname"]').fill(INVESTOR_NICKNAME);
    await page.locator('input[name="password"]').fill(INVESTOR_PASSWORD);
    await page.getByRole("button", { name: /přihlásit se/i }).click();
    await expect(page).not.toHaveURL(/\/login/);

    // The client signs the other side of the handover: the same dialog, the investor's own password, no ČKAIT number
    await page.goto(`${projectUrl}?tab=handovers`);
    const signedByContractor = page.locator(`#handover-${stored.id}`);
    const unsigned = page.locator(`#handover-${unsignedHandoverId}`);
    await expect(signedByContractor.getByText("Podepsal zhotovitel, čeká na stavebníka")).toBeVisible({ timeout: 15_000 });
    // On the protocol nobody has signed the manager had "Upravit" and the contractor's signature (above): the client has neither, and has their own.
    await expect(unsigned.getByText("Druhé předání")).toBeVisible();
    await expect(unsigned.getByRole("button", { name: "Podepsat za stavebníka" })).toBeVisible();
    await expect(unsigned.getByRole("button", { name: "Upravit", exact: true })).toHaveCount(0);
    await expect(unsigned.getByRole("button", { name: "Podepsat za zhotovitele" })).toHaveCount(0);
    await signedByContractor.getByRole("button", { name: "Podepsat za stavebníka" }).click();
    const clientSign = page.getByRole("dialog", { name: /Podepsat předání za stavebníka/i });
    await clientSign.getByLabel("Heslo").fill(INVESTOR_PASSWORD);
    await clientSign.getByRole("button", { name: "Podepsat", exact: true }).click();
    await expect(page.getByText("Podepsáno oběma stranami")).toBeVisible();
    await expect(page.getByText(/Podepsal\(a\) E2E Investor \(Stavebník\), /)).toBeVisible();
    // Both sides have signed: the button the client just used is gone (it was there a moment ago)
    await expect(signedByContractor.getByRole("button", { name: /Podepsat za/ })).toHaveCount(0);

    // The entry nobody has signed: for the manager it was the form with its save and sign buttons (above); for the client it is the
    // document, with the text and the state, and none of them.
    await page.goto(`${projectUrl}/reports/${draftDay}`);
    await expect(page.getByText("Rozpracováno pro stavebníka")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Rozpracováno", { exact: true })).toBeVisible();
    await expect(page.locator('textarea[name="workDescription"]')).toHaveCount(0);
    await expect(page.getByRole("button", { name: /uložit (záznam|změny)/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /podepsat a uzamknout/i })).toHaveCount(0);

    // Go to report
    await page.goto(reportUrl);
    await expect(page.getByRole("group", { name: "Stav záznamu" }).getByText("Kontrolní den", { exact: true })).toBeVisible();
    await expect(page.getByText("SO: SO-101")).toBeVisible();

    // Verify investor sees and can click Acknowledge button
    const ackBtn = page.getByRole("button", { name: /potvrdit seznámení/i });
    await expect(ackBtn).toBeVisible();

    // The application asks in a dialog of its own, with the safe answer in focus; "Zrušit" would have changed nothing
    await ackBtn.click();
    const confirmAck = page.getByRole("dialog", { name: "Potvrdit seznámení?" });
    await expect(confirmAck.getByRole("button", { name: "Zrušit", exact: true })).toBeFocused();
    await confirmAck.getByRole("button", { name: "Potvrdit seznámení", exact: true }).click();

    // Verify acknowledged status appears in header
    await expect(page.getByText(/Seznámil\(a\) se: .*\(stavebník\)/)).toBeVisible();
    await expect(ackBtn).not.toBeVisible();
    // The button that asked is gone with the acknowledgement: the focus is on the heading of the page, not lost to the top of the document
    await expect(page.getByRole("heading", { level: 1 })).toBeFocused();

    // An investor reads the daily entry but does not write it: a day nobody wrote says so, with no form and no save button.
    const yesterday = new Date(`${new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Prague" }).format(new Date())}T00:00:00Z`);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    await page.goto(reportUrl.replace(/\/reports\/.*$/, `/reports/${yesterday.toISOString().slice(0, 10)}`));
    await expect(page.getByText(/můžete jen číst/i)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Za tento den zatím není žádný záznam.")).toBeVisible();
    await expect(page.locator('textarea[name="workDescription"]')).toHaveCount(0);
    await expect(page.getByRole("button", { name: /uložit (záznam|změny)/i })).toHaveCount(0);
  });
});
