import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import type { AuditContext } from "@/server/audit";
import * as auditCtx from "@/server/audit-context";
import type { SessionUser } from "@/server/rbac";
import * as rbac from "@/server/rbac";
import { actionClient, authActionClient, adminActionClient, bossActionClient } from "./safe-action";

// Mock dependencies
vi.mock("@/server/rbac", () => ({
  requireUser: vi.fn(),
  requireAdmin: vi.fn(),
  requireBoss: vi.fn(),
}));

vi.mock("@/server/audit-context", () => ({
  getAuditContext: vi.fn(),
}));

function createMockUser(overrides: Partial<SessionUser> = {}): SessionUser {
  return {
    id: "user1",
    nickname: "tester",
    displayName: "Test User",
    role: "WORKER",
    isAdmin: false,
    mustChangePwd: false,
    sessionId: "sess1",
    ...overrides,
  };
}

const mockAuditContext: AuditContext = {
  actor: { id: "user1" },
  ip: null,
  userAgent: "test",
};

describe("Safe Action Clients", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("authActionClient calls requireUser and getAuditContext", async () => {
    vi.mocked(rbac.requireUser).mockResolvedValue(createMockUser());
    vi.mocked(auditCtx.getAuditContext).mockResolvedValue(mockAuditContext);

    const action = authActionClient
      .schema(z.object({ msg: z.string() }))
      .action(async ({ parsedInput, ctx }) => {
        return { msg: parsedInput.msg, user: ctx.user.id };
      });

    const res = await action({ msg: "hello" });

    expect(res?.data).toEqual({ msg: "hello", user: "user1" });
    expect(rbac.requireUser).toHaveBeenCalled();
    expect(auditCtx.getAuditContext).toHaveBeenCalled();
  });

  it("adminActionClient blocks non-admin users", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(rbac.requireAdmin).mockRejectedValue(new Error("Forbidden"));

    const action = adminActionClient.schema(z.object({})).action(async () => {
      return { ok: true };
    });

    const res = await action({});
    // actionClient catches errors by default and returns serverError
    expect(res?.serverError).toBeDefined();
    expect(res?.serverError).toBe("Při zpracování požadavku došlo k chybě.");
  });

  it("bossActionClient calls requireBoss and getAuditContext", async () => {
    vi.mocked(rbac.requireBoss).mockResolvedValue(createMockUser({ id: "boss1", role: "BOSS" }));
    vi.mocked(auditCtx.getAuditContext).mockResolvedValue({
      ...mockAuditContext,
      actor: { id: "boss1" },
    });

    const action = bossActionClient
      .schema(z.object({ value: z.number() }))
      .action(async ({ parsedInput, ctx }) => {
        return { value: parsedInput.value, user: ctx.user.id };
      });

    const res = await action({ value: 42 });

    expect(res?.data).toEqual({ value: 42, user: "boss1" });
    expect(rbac.requireBoss).toHaveBeenCalled();
    expect(auditCtx.getAuditContext).toHaveBeenCalled();
  });

  it("actionClient handles unexpected server errors", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const action = actionClient.schema(z.object({})).action(async () => {
      throw new Error("Boom");
    });

    const res = await action({});
    expect(res?.serverError).toBe("Při zpracování požadavku došlo k chybě.");
  });

  it("handles schema validation errors gracefully", async () => {
    const action = actionClient
      .schema(z.object({ email: z.string().email(), age: z.number().min(18) }))
      .action(async ({ parsedInput }) => parsedInput);

    const res = await action({ email: "invalid", age: 10 });
    expect(res?.validationErrors).toBeDefined();
    expect(res?.validationErrors?.email).toBeDefined();
    expect(res?.validationErrors?.age).toBeDefined();
  });
});
