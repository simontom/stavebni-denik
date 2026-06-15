import { promises as fs } from "node:fs";
import path from "node:path";

import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { env } from "@/lib/env";

// Health checks must always hit live services — never serve from cache.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type ProbeStatus = "ok" | "error";

interface ProbeResult {
  status: ProbeStatus;
  durationMs: number;
  message?: string;
}

async function probeDatabase(): Promise<ProbeResult> {
  const started = Date.now();
  try {
    // `SELECT 1` round-trip; cheapest possible liveness signal.
    await prisma.$queryRaw`SELECT 1`;
    return { status: "ok", durationMs: Date.now() - started };
  } catch (err) {
    return {
      status: "error",
      durationMs: Date.now() - started,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

async function probeVolume(): Promise<ProbeResult> {
  const started = Date.now();
  const probeFile = path.join(env.dataDir, ".healthz");
  try {
    await fs.mkdir(env.dataDir, { recursive: true });
    await fs.writeFile(probeFile, `${Date.now()}`, "utf8");
    await fs.unlink(probeFile);
    return { status: "ok", durationMs: Date.now() - started };
  } catch (err) {
    return {
      status: "error",
      durationMs: Date.now() - started,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Health-check endpoint consumed by Fly.io / Railway probes.
 *
 * Returns 200 only when both Postgres and the persistent volume are
 * reachable. Anything else returns 503 — orchestrator will restart /
 * stop routing traffic to this instance.
 */
export async function GET() {
  const [database, volume] = await Promise.all([
    probeDatabase(),
    probeVolume(),
  ]);
  const allOk = database.status === "ok" && volume.status === "ok";
  return NextResponse.json(
    {
      status: allOk ? "ok" : "error",
      checkedAt: new Date().toISOString(),
      checks: { database, volume },
    },
    { status: allOk ? 200 : 503 },
  );
}
