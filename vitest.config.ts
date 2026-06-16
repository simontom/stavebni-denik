import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const resolvePath = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * Unit-test configuration.
 *
 * - Aliases `@/...` to `src/...` (mirrors tsconfig paths) and `server-only`
 *   to an empty stub so server modules can be imported under plain Node.
 * - Only picks up co-located `*.test.ts` files under `src/` plus anything
 *   in `test/unit/`. Integration tests (which need Docker) live in
 *   `test/integration/` and run via `vitest.integration.config.ts`.
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
    include: ["src/**/*.test.ts", "test/unit/**/*.test.ts"],
  },
});
