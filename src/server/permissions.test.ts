import { describe, expect, it } from "vitest";

import {
  type Action,
  ForbiddenError,
  type Role,
  type SessionUser,
  assertCan,
  can,
  canAccessProject,
} from "./permissions";

function user(
  role: Role,
  id = "u1",
  opts: { isAdmin?: boolean } = {},
): SessionUser {
  return {
    id,
    nickname: role.toLowerCase(),
    displayName: role,
    role,
    isAdmin: opts.isAdmin ?? false,
    mustChangePwd: false,
    sessionId: "session-1",
  };
}

const BOSS = user("BOSS", "boss1");
const WORKER = user("WORKER", "worker1");
const GUEST = user("GUEST", "guest1");

// Admin users — orthogonal to role. ADMIN_BOSS = majitel firmy
// (typický seedovaný admin); ADMIN_WORKER = účetní/asistent co
// spravuje účty ale není stavbyvedoucí.
const ADMIN_BOSS = user("BOSS", "admin1", { isAdmin: true });
const ADMIN_WORKER = user("WORKER", "admin2", { isAdmin: true });

describe("can — BOSS (stavbyvedoucí, no isAdmin)", () => {
  it("grants project management + report signing", () => {
    expect(can(BOSS, "project.create")).toBe(true);
    expect(can(BOSS, "report.sign")).toBe(true);
    expect(can(BOSS, "project.delete")).toBe(true);
  });

  it("DOES NOT grant admin actions without isAdmin flag", () => {
    // Splits: stavbyvedoucí bez admin flagu nemůže spravovat
    // uživatele ani číst audit log (Vyhláška 499/2006 §153 vyžaduje
    // jen ČKAIT, ne adminship).
    expect(can(BOSS, "user.create")).toBe(false);
    expect(can(BOSS, "user.deactivate")).toBe(false);
    expect(can(BOSS, "audit.read")).toBe(false);
    expect(can(BOSS, "audit.verify")).toBe(false);
  });

  it("allows editing an unlocked report but not a locked one", () => {
    expect(can(BOSS, "report.update", { reportLocked: false })).toBe(true);
    expect(can(BOSS, "report.update", { reportLocked: true })).toBe(false);
  });
});

describe("can — isAdmin flag (orthogonal to role)", () => {
  it("ADMIN_BOSS (typický majitel firmy) má oboje — admin i stavbyvedoucí", () => {
    expect(can(ADMIN_BOSS, "user.create")).toBe(true);
    expect(can(ADMIN_BOSS, "audit.read")).toBe(true);
    expect(can(ADMIN_BOSS, "project.create")).toBe(true);
    expect(can(ADMIN_BOSS, "report.sign")).toBe(true);
  });

  it("ADMIN_WORKER (účetní/asistent) spravuje uživatele, ale NE zakázky", () => {
    expect(can(ADMIN_WORKER, "user.create")).toBe(true);
    expect(can(ADMIN_WORKER, "user.deactivate")).toBe(true);
    expect(can(ADMIN_WORKER, "audit.read")).toBe(true);
    // Worker, i když je admin, NEMŮŽE založit projekt / podepsat
    // deník — to je doménová akce stavbyvedoucího (role=BOSS).
    expect(can(ADMIN_WORKER, "project.create")).toBe(false);
    expect(can(ADMIN_WORKER, "project.delete")).toBe(false);
    expect(can(ADMIN_WORKER, "report.sign")).toBe(false);
  });
});

describe("can — WORKER", () => {
  it("cannot perform admin actions", () => {
    expect(can(WORKER, "user.create")).toBe(false);
    expect(can(WORKER, "project.create")).toBe(false);
    expect(can(WORKER, "audit.verify")).toBe(false);
  });

  it("creates reports only on projects it is a member of", () => {
    expect(can(WORKER, "report.create", { projectMember: true })).toBe(true);
    expect(can(WORKER, "report.create", { projectMember: false })).toBe(false);
  });

  it("edits only its own, unlocked reports", () => {
    const own = { projectMember: true, authorId: "worker1", reportLocked: false };
    expect(can(WORKER, "report.update", own)).toBe(true);

    const someoneElse = { ...own, authorId: "worker2" };
    expect(can(WORKER, "report.update", someoneElse)).toBe(false);

    const locked = { ...own, reportLocked: true };
    expect(can(WORKER, "report.update", locked)).toBe(false);
  });
});

describe("can — GUEST", () => {
  it("may add remarks on member projects but cannot edit reports", () => {
    expect(can(GUEST, "remark.create", { projectMember: true })).toBe(true);
    expect(can(GUEST, "remark.create", { projectMember: false })).toBe(false);
    expect(can(GUEST, "report.update", { projectMember: true })).toBe(false);
    expect(can(GUEST, "report.create", { projectMember: true })).toBe(false);
    expect(can(GUEST, "photo.upload", { projectMember: true })).toBe(false);
  });
});

describe("can — wildcard resistance", () => {
  it("denies any action that is not in the matrix", () => {
    expect(can(BOSS, "totally.unknown" as Action)).toBe(false);
  });
});

describe("canAccessProject — visibility scope", () => {
  it("lets BOSS see every project regardless of membership", () => {
    expect(canAccessProject("BOSS", true)).toBe(true);
    expect(canAccessProject("BOSS", false)).toBe(true);
  });

  it("lets WORKER/GUEST see a project only when they are a member", () => {
    expect(canAccessProject("WORKER", true)).toBe(true);
    expect(canAccessProject("WORKER", false)).toBe(false);
    expect(canAccessProject("GUEST", true)).toBe(true);
    expect(canAccessProject("GUEST", false)).toBe(false);
  });
});

describe("assertCan", () => {
  it("throws ForbiddenError when denied", () => {
    expect(() => assertCan(GUEST, "report.update", { projectMember: true })).toThrow(
      ForbiddenError,
    );
  });

  it("does not throw when allowed", () => {
    // user.create vyžaduje isAdmin — bare BOSS to nemá.
    expect(() => assertCan(ADMIN_BOSS, "user.create")).not.toThrow();
  });
});
