import { expect, test } from "@playwright/test";
import {
  ADMIN_NICKNAME,
  ADMIN_PASSWORD,
  INVESTOR_NICKNAME,
  INVESTOR_PASSWORD,
} from "./global-setup";

test.describe("Legislative Compliance", () => {
  test("complete flow: legislative fields, site handovers, authorized persons, and investor acknowledgment", async ({
    page,
  }) => {
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

    // 4. Test Site Handovers (Předání staveniště)
    await page.getByRole("link", { name: /Předání staveniště/i }).click();
    await page.getByRole("button", { name: /Přidat předání/i }).click();

    await page.locator('input[id="handover-type"]').fill("Předání staveniště zhotoviteli");
    await page.locator('input[id="handover-date"]').fill("2026-09-11");
    await page
      .locator('input[id="handover-participants"]')
      .fill("Ing. Jan Novák (objednatel), Petr Svoboda (zhotovitel)");

    await page.getByRole("button", { name: /Přidat měřidlo/i }).click();
    await page.locator('input[placeholder*="Médium"]').fill("Elektřina VT");
    await page.locator('input[placeholder*="Výrobní číslo"]').fill("EL-98765");
    await page.locator('input[placeholder*="Stav"]').fill("12450 kWh");

    await page
      .locator('textarea[id="handover-notes"]')
      .fill("Staveniště předáno bez výhrad.");

    await page.getByRole("button", { name: /Uložit předání/i }).click();

    // Verify record in list
    await expect(page.getByText("Předání staveniště zhotoviteli")).toBeVisible();
    await expect(
      page.getByText("Ing. Jan Novák (objednatel), Petr Svoboda (zhotovitel)"),
    ).toBeVisible();
    await expect(page.getByText("Elektřina VT")).toBeVisible();
    await expect(page.getByText("12450 kWh")).toBeVisible();
    await expect(page.getByText("Čeká na podpis")).toBeVisible();

    // Sign handover
    page.once("dialog", (d) => d.accept());
    await page.getByRole("button", { name: /Podepsat předání/i }).click();
    await expect(page.getByText(/Podepsáno dne/i)).toBeVisible();

    // 5. Test Authorized Persons (Pověřené osoby)
    await page.getByRole("link", { name: /Členové/i }).click();
    await expect(page.getByText("Seznam pověřených osob")).toBeVisible();

    await page.getByRole("button", { name: /Přidat osobu/i }).click();
    await page.locator('input[id="person-name"]').fill("Ing. Arch. Petr Černý");
    await page.locator('input[id="person-company"]').fill("Architekti s.r.o.");
    await page
      .locator('input[id="person-auth"]')
      .fill("Autorský dozor projektanta");
    await page.getByRole("button", { name: /^Uložit$/i }).click();

    await expect(page.getByText("Ing. Arch. Petr Černý")).toBeVisible();
    await expect(page.getByText("Architekti s.r.o.")).toBeVisible();
    await expect(page.getByText("Autorský dozor projektanta")).toBeVisible();

    // Revoke external person
    page.once("dialog", (d) => d.accept());
    await page
      .getByRole("button", { name: /Zrušit Ing. Arch. Petr Černý/i })
      .click();
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
    await page.locator('input[id="new-report-date"]').fill("2026-09-11");
    await page.getByRole("button", { name: /otevřít den/i }).click();

    await expect(page).toHaveURL(/\/projects\/.+\/reports\/.+/);
    await page.locator('input[name="isControlDay"]').check();
    await page.locator('input[name="constructionObj"]').fill("SO-101");
    await page.locator('textarea[name="workDescription"]').fill("Práce na SO-101");
    await page.getByRole("button", { name: /vytvořit záznam/i }).click();

    // Verify badges
    await expect(page.getByText("Kontrolní den")).toBeVisible();
    await expect(page.getByText("SO: SO-101")).toBeVisible();
    const reportUrl = page.url();

    // 8. Log in as INVESTOR and acknowledge report
    await page.context().clearCookies();
    await page.goto("/login");
    await page.locator('input[name="nickname"]').fill(INVESTOR_NICKNAME);
    await page.locator('input[name="password"]').fill(INVESTOR_PASSWORD);
    await page.getByRole("button", { name: /přihlásit se/i }).click();
    await expect(page).not.toHaveURL(/\/login/);

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
    await expect(page.getByText(/Potvrzeno investorem/i)).toBeVisible();
    await expect(ackBtn).not.toBeVisible();
  });
});
