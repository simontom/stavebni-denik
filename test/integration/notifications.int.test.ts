import { execSync } from "node:child_process";

import { PrismaPg } from "@prisma/adapter-pg";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@/generated/prisma/client";

/**
 * Integration test for the in-app notification service against a real
 * Postgres (Testcontainers). Notifications are intentionally NOT
 * routed through `withAudit`, so this suite is independent of the
 * audit-chain tests; we still verify the recipient scoping
 * (markRead refuses to touch other users' rows even with the right
 * id) and the FK protection on a stale recipient.
 */

let container: StartedPostgreSqlContainer;
let db: PrismaClient;
let svc: typeof import("@/server/services/notifications");

let alice: string;
let bob: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  const url = container.getConnectionUri();
  process.env.DATABASE_URL = url;

  execSync("pnpm exec prisma migrate deploy", {
    env: { ...process.env, DATABASE_URL: url },
    stdio: "inherit",
  });

  db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });

  const a = await db.user.create({
    data: {
      nickname: "alice",
      displayName: "Alice",
      passwordHash: "x",
      role: "BOSS",
      mustChangePwd: false,
    },
  });
  const b = await db.user.create({
    data: {
      nickname: "bob",
      displayName: "Bob",
      passwordHash: "x",
      role: "WORKER",
      mustChangePwd: false,
    },
  });
  alice = a.id;
  bob = b.id;

  svc = await import("@/server/services/notifications");
}, 180_000);

afterAll(async () => {
  await db?.$disconnect();
  await container?.stop();
});

describe("notifications — service (real Postgres)", () => {
  it("creates a notification and counts it as unread", async () => {
    const id = await svc.notifyUser({
      recipientId: alice,
      kind: "audit.chain_broken",
      payload: { rowId: "42", reason: "tampered hash" },
      href: "/admin/audit",
    });
    expect(id).not.toBeNull();

    expect(await svc.countUnreadForUser(alice)).toBe(1);
    expect(await svc.countUnreadForUser(bob)).toBe(0);

    const list = await svc.listNotificationsForUser({ userId: alice });
    expect(list).toHaveLength(1);
    expect(list[0]!.kind).toBe("audit.chain_broken");
    expect(list[0]!.readAt).toBeNull();
  });

  it("notifyByRole fans out to every active BOSS user", async () => {
    // Add a second BOSS so we can verify the fan-out includes both.
    const carla = await db.user.create({
      data: {
        nickname: "carla",
        displayName: "Carla",
        passwordHash: "x",
        role: "BOSS",
        mustChangePwd: false,
      },
    });

    const before = await db.notification.count();
    const sent = await svc.notifyByRole({
      roles: ["BOSS"],
      kind: "audit.chain_broken",
      payload: { rowId: "99" },
      href: "/admin/audit",
    });
    const after = await db.notification.count();

    expect(sent).toBeGreaterThanOrEqual(2);
    expect(after - before).toBe(sent);
    // Bob (WORKER) must NOT have received the broadcast.
    expect(await svc.countUnreadForUser(bob)).toBe(0);

    // Cleanup so following tests start from a clean slate.
    await db.notification.deleteMany({ where: { recipientId: carla.id } });
    await db.user.delete({ where: { id: carla.id } });
  });

  it("markNotificationRead refuses to touch other users' rows", async () => {
    const aliceId = await svc.notifyUser({
      recipientId: alice,
      kind: "report.signed",
      payload: { projectName: "Stavba A", date: "2026-06-15" },
    });
    expect(aliceId).not.toBeNull();

    // Bob can NOT mark Alice's notification read.
    const okBob = await svc.markNotificationRead({
      notificationId: aliceId!,
      userId: bob,
    });
    expect(okBob).toBe(false);

    // The row is still unread for Alice.
    const stillUnread = await db.notification.findUniqueOrThrow({
      where: { id: aliceId! },
    });
    expect(stillUnread.readAt).toBeNull();

    // Alice can — and the row updates.
    const okAlice = await svc.markNotificationRead({
      notificationId: aliceId!,
      userId: alice,
    });
    expect(okAlice).toBe(true);
    const after = await db.notification.findUniqueOrThrow({
      where: { id: aliceId! },
    });
    expect(after.readAt).toBeInstanceOf(Date);

    // Re-marking is idempotent (returns false because where filter
    // already excludes read rows; readAt stays the same).
    const okAgain = await svc.markNotificationRead({
      notificationId: aliceId!,
      userId: alice,
    });
    expect(okAgain).toBe(false);
  });

  it("markAllNotificationsRead clears every unread for one user", async () => {
    // Make sure Alice has at least 3 unread notifications.
    for (let i = 0; i < 3; i++) {
      await svc.notifyUser({
        recipientId: alice,
        kind: "report.signed",
        payload: { projectName: "X", date: `2026-06-${10 + i}` },
      });
    }
    const before = await svc.countUnreadForUser(alice);
    expect(before).toBeGreaterThanOrEqual(3);

    const cleared = await svc.markAllNotificationsRead(alice);
    expect(cleared).toBe(before);
    expect(await svc.countUnreadForUser(alice)).toBe(0);
  });

  it("deleteNotification refuses to touch other users' rows", async () => {
    const aliceId = await svc.notifyUser({
      recipientId: alice,
      kind: "report.signed",
      payload: { projectName: "Y" },
    });
    expect(aliceId).not.toBeNull();

    const okBob = await svc.deleteNotification({
      notificationId: aliceId!,
      userId: bob,
    });
    expect(okBob).toBe(false);
    const stillThere = await db.notification.findUnique({
      where: { id: aliceId! },
    });
    expect(stillThere).not.toBeNull();

    const okAlice = await svc.deleteNotification({
      notificationId: aliceId!,
      userId: alice,
    });
    expect(okAlice).toBe(true);
    const gone = await db.notification.findUnique({
      where: { id: aliceId! },
    });
    expect(gone).toBeNull();
  });

  it("notifyUser silently skips a stale recipient id", async () => {
    const id = await svc.notifyUser({
      recipientId: "nonexistent-id",
      kind: "report.signed",
      payload: {},
    });
    expect(id).toBeNull();
  });
});
