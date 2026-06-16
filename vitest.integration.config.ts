import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const resolvePath = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * Integration-test configuration.
 *
 * These tests spin up a real Postgres via Testcontainers and therefore
 * require a running Docker daemon. They are NOT part of `pnpm test`; run
 * them explicitly with `pnpm test:integration` (Docker available) or in
 * CI on a runner that provides Docker.
 */
export default defineConfig({
  resolve: {
    alias: [
      { find: /^@\//, replacement: resolvePath("./src") + "/" },
      {
        find: "server-only",
        replacement: resolvePath("./test/stubs/server-only.ts"),
      },
    ],
  },
  test: {
    environment: "node",
    include: ["test/integration/**/*.int.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 180_000,
    // Containers are heavy; do not run integration files in parallel.
    fileParallelism: false,
  },
});
