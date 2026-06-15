/**
 * Prisma client singleton.
 *
 * Next.js dev server hot-reloads server modules which would otherwise
 * spawn a new `PrismaClient` per reload and exhaust DB connections.
 * We cache the instance on `globalThis` in non-production environments.
 *
 * The generator output is `src/generated/prisma` (see prisma/schema.prisma)
 * so we import from there instead of `@prisma/client`.
 */

import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "@/generated/prisma/client";
import { env } from "@/lib/env";

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
};

function createPrismaClient(): PrismaClient {
  const adapter = new PrismaPg({ connectionString: env.databaseUrl });
  return new PrismaClient({
    adapter,
    log:
      process.env.NODE_ENV === "development"
        ? ["error", "warn"]
        : ["error", "warn"],
  });
}

export const prisma: PrismaClient =
  globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
