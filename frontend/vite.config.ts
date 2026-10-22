/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  css: {
    postcss: {},
  },
  // Unit tests (pure modules in src/lib, no DOM): `pnpm test`. The browser behaviour is covered by the Playwright suite in e2e/.
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:8080",
        changeOrigin: true,
      },
      "/healthz": {
        target: "http://localhost:8080",
        changeOrigin: true,
        rewrite: () => "/api/health",
      },
    },
    headers: {
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self';",
      "X-Frame-Options": "DENY",
      "X-Content-Type-Options": "nosniff",
      // Same values as the backend (Application.kt): the E2E suite reads these headers from this server.
      "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Resource-Policy": "same-site",
      "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
    },
  },
});
