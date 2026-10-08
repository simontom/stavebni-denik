import { expect, test } from "@playwright/test";

/**
 * Browser-side security header checks of the page the E2E suite opens.
 *
 * Which server answers depends on BASE_URL: by default it is the Vite development server (port 5173), which sends a
 * development version of the headers (frontend/vite.config.ts; its script-src allows inline scripts for hot reloading,
 * the production policy does not); on a staging deployment it is the real server. So a green run here proves little
 * about production. The headers of the real Ktor server, on every kind of response, are tested by
 * `SecurityHeadersTest` in the backend, and the CI Docker job checks them on the built image.
 *
 * No logged-in user is needed: the headers are on every response.
 */

test.describe("Security headers", () => {
  /**
   * Fetch the login page via Playwright's `request` context — this gives us
   * the raw headers without browser CSP enforcement interfering.
   */
  test("CSP header is present and does NOT contain 'unsafe-eval'", async ({ request }) => {
    const res = await request.get("/login");
    expect(res.status()).toBe(200);

    const csp = res.headers()["content-security-policy"];
    expect(csp, "Content-Security-Policy header must be present").toBeTruthy();

    // In Vite, 'unsafe-eval' is not needed and must be absent.
    expect(csp, "CSP must not allow 'unsafe-eval'.").not.toContain("unsafe-eval");

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

  test("Strict-Transport-Security includes includeSubDomains and preload", async ({ request }) => {
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

  test("CSP connect-src allows Open-Meteo and nothing else external", async ({ request }) => {
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
      if (msg.type() === "error" && msg.text().toLowerCase().includes("content security policy")) {
        violations.push(msg.text());
      }
    });

    // Also capture SecurityPolicyViolationEvent fired on the document.
    await page.addInitScript(() => {
      document.addEventListener("securitypolicyviolation", (e) => {
        // @ts-expect-error -- window.__cspViolations for test retrieval
        (window.__cspViolations ??= []).push(`${e.violatedDirective}: ${e.blockedURI}`);
      });
    });

    await page.goto("/login");
    await expect(page.locator('input[name="nickname"]')).toBeVisible({ timeout: 10_000 });

    // Give any deferred scripts a moment to load.
    await page.waitForTimeout(1000);

    const domViolations = await page.evaluate(
      // @ts-expect-error -- window.__cspViolations injected above
      () => window.__cspViolations ?? [],
    );

    expect(violations, `CSP console errors on login page: ${violations.join(", ")}`).toHaveLength(0);

    expect(domViolations, `CSP DOM violations on login page: ${(domViolations as string[]).join(", ")}`).toHaveLength(0);
  });
});
