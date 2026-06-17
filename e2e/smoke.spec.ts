import { expect, test } from "@playwright/test";

/**
 * Smoke test that does NOT require a seeded user — the goal is to
 * catch obvious end-to-end breakage (middleware redirects work,
 * login page renders, server validates credentials and surfaces an
 * error). Login flow with a valid user belongs in a follow-up
 * staging-targeted suite once we have a deploy pipeline.
 */

test("middleware redirects unauthenticated visitors to /login", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login(\?|$)/);
  await expect(page.locator('input[name="nickname"]')).toBeVisible();
  await expect(page.locator('input[name="password"]')).toBeVisible();
  await expect(page.locator('button[type="submit"]')).toContainText(
    /přihlásit se/i,
  );
});

test("rejects bad credentials with an error message", async ({ page }) => {
  await page.goto("/login");
  await page.locator('input[name="nickname"]').fill("definitely-not-a-real-user");
  await page.locator('input[name="password"]').fill("wrong-password-123!");
  await page.locator('button[type="submit"]').click();
  await expect(
    page.getByText(/neplatné přihlašovací jméno nebo heslo/i),
  ).toBeVisible({ timeout: 15_000 });
});

test("healthz endpoint returns 200 OK", async ({ request }) => {
  const res = await request.get("/healthz");
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.status).toBe("ok");
});
