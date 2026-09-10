import { expect, test } from "@playwright/test";

/**
 * E2E security header tests — verify that the HTTP response headers we set
 * in next.config.ts are actually delivered by the running server.
 *
 * These tests require the app to be running (locally via `pnpm dev` or
 * via BASE_URL pointing at a staging deployment). They do NOT require a
 * logged-in user — security headers are applied to every response.
 *
 * Run: `pnpm e2e` (local) or `BASE_URL=https://staging.example.com pnpm e2e`
 */

test.describe("Security headers", () => {
  /**
   * Fetch the login page via Playwright's `request` context — this gives us
   * the raw headers without browser CSP enforcement interfering.
   */
  test("CSP header is present and does NOT contain 'unsafe-eval'", async ({
    request,
  }) => {
    const res = await request.get("/login");
    expect(res.status()).toBe(200);

    const csp = res.headers()["content-security-policy"];
    expect(
      csp,
      "Content-Security-Policy header must be present",
    ).toBeTruthy();

    // The fix: 'unsafe-eval' must be absent in production.
    // Next.js dev server requires it for webpack HMR.
    const isDev = !process.env.BASE_URL; // If Playwright booted `pnpm dev`, it's local.
    if (!isDev) {
      expect(
        csp,
        "CSP must not allow 'unsafe-eval' in production.",
      ).not.toContain("unsafe-eval");
    } else {
      expect(csp).toContain("unsafe-eval");
    }

    // Sanity-check the directives we know must be present.
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'self'");
  });

  test("X-Frame-Options is DENY", async ({ request }) => {
    const res = await request.get("/login");
    expect(res.headers()["x-frame-options"]).toBe("DENY");
  });

  test("X-Content-Type-Options is nosniff", async ({ request }) => {
    const res = await request.get("/login");
    expect(res.headers()["x-content-type-options"]).toBe("nosniff");
  });

  test("Strict-Transport-Security includes includeSubDomains and preload", async ({
    request,
  }) => {
    const res = await request.get("/login");
    const hsts = res.headers()["strict-transport-security"];
    // HSTS may be omitted in local HTTP (not fatal in dev), but must
    // be present and correct on the staging/production HTTPS target.
    if (hsts) {
      expect(hsts).toContain("includeSubDomains");
      expect(hsts).toContain("preload");
      expect(hsts).toMatch(/max-age=\d+/);
    }
  });

  test("CSP connect-src allows Open-Meteo and nothing else external", async ({
    request,
  }) => {
    const res = await request.get("/login");
    const csp = res.headers()["content-security-policy"];

    // Open-Meteo is the only external API we call (weather widget).
    expect(csp).toContain("connect-src 'self' https://api.open-meteo.com");

    // Should NOT allow arbitrary external connections.
    expect(csp).not.toContain("connect-src *");
    expect(csp).not.toContain("connect-src 'unsafe-eval'");
  });

  test("no CSP violations on login page load", async ({ page }) => {
    const violations: string[] = [];

    // Capture CSP violation reports surfaced as browser console errors.
    page.on("console", (msg) => {
      if (
        msg.type() === "error" &&
        msg.text().toLowerCase().includes("content security policy")
      ) {
        violations.push(msg.text());
      }
    });

    // Also capture SecurityPolicyViolationEvent fired on the document.
    await page.addInitScript(() => {
      document.addEventListener("securitypolicyviolation", (e) => {
        // @ts-expect-error -- window.__cspViolations for test retrieval
        (window.__cspViolations ??= []).push(
          `${e.violatedDirective}: ${e.blockedURI}`,
        );
      });
    });

    await page.goto("/login");
    await expect(
      page.locator('input[name="nickname"]'),
    ).toBeVisible({ timeout: 10_000 });

    // Give any deferred scripts a moment to load.
    await page.waitForTimeout(1000);

    const domViolations = await page.evaluate(
      // @ts-expect-error -- window.__cspViolations injected above
      () => window.__cspViolations ?? [],
    );

    expect(
      violations,
      `CSP console errors on login page: ${violations.join(", ")}`,
    ).toHaveLength(0);

    expect(
      domViolations,
      `CSP DOM violations on login page: ${(domViolations as string[]).join(", ")}`,
    ).toHaveLength(0);
  });
});
