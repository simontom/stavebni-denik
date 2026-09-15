/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import * as rbac from "@/server/rbac";
import * as auditCtx from "@/server/audit-context";
import * as projectsService from "@/server/services/projects";
import * as handoversService from "@/server/services/site-handovers";
import * as personsService from "@/server/services/authorized-persons";

import {
  updateProjectAction,
  addMemberAction,
  removeMemberAction,
  archiveProjectAction,
  restoreProjectAction,
  createHandoverAction,
  signHandoverAction,
  deleteHandoverAction,
  addAuthorizedPersonAction,
  updateAuthorizedPersonAction,
  revokeAuthorizedPersonAction,
} from "./actions";

// Mock next utilities
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
}));

// Mock rbac and audit-context
vi.mock("@/server/rbac", () => ({
  requireUser: vi.fn(),
  requireAdmin: vi.fn(),
  requireBoss: vi.fn(),
}));

vi.mock("@/server/audit-context", () => ({
  getAuditContext: vi.fn(),
}));

// Mock services
vi.mock("@/server/services/projects", () => ({
  addProjectMember: vi.fn(),
  archiveProject: vi.fn(),
  removeProjectMember: vi.fn(),
  restoreProject: vi.fn(),
  updateProject: vi.fn(),
  normalizeProjectForm: vi.fn((data: FormData) => {
    return Object.fromEntries(data.entries());
  }),
  createProjectSchema: {
    safeParse: vi.fn(),
  },
  ProjectNotFoundError: class ProjectNotFoundError extends Error {},
  SiteManagerInvalidError: class SiteManagerInvalidError extends Error {},
}));

vi.mock("@/server/services/site-handovers", () => ({
  createHandover: vi.fn(),
  deleteHandover: vi.fn(),
  signHandover: vi.fn(),
}));

vi.mock("@/server/services/authorized-persons", () => ({
  addExternalPerson: vi.fn(),
  revokePerson: vi.fn(),
  updatePerson: vi.fn(),
}));

function createMockUser(overrides: any = {}) {
  return {
    id: "user1",
    nickname: "tester",
    displayName: "Test User",
    role: "BOSS",
    isAdmin: false,
    mustChangePwd: false,
    sessionId: "sess1",
    ...overrides,
  };
}

const mockAuditContext = {
  actor: { id: "user1" },
  ip: null,
  userAgent: "test",
};

describe("Projects Actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(rbac.requireBoss).mockResolvedValue(createMockUser());
    vi.mocked(auditCtx.getAuditContext).mockResolvedValue(mockAuditContext as any);
  });

  describe("updateProjectAction", () => {
    it("returns forbidden if requireBoss fails", async () => {
      vi.mocked(rbac.requireBoss).mockRejectedValueOnce(new Error("Forbidden"));
      const formData = new FormData();
      const res = await updateProjectAction("proj-1", undefined, formData);
      expect(res).toEqual({ status: "forbidden" });
    });

    it("returns field-error if validation fails", async () => {
      vi.mocked(projectsService.createProjectSchema.safeParse).mockReturnValueOnce({
        success: false,
        error: { issues: [{ path: ["name"], message: "Jméno je povinné" }] },
      } as any);

      const formData = new FormData();
      const res = await updateProjectAction("proj-1", undefined, formData);

      expect(res).toEqual({
        status: "field-error",
        fieldErrors: { name: "Jméno je povinné" },
      });
    });

    it("handles SiteManagerInvalidError database error", async () => {
      vi.mocked(projectsService.createProjectSchema.safeParse).mockReturnValueOnce({
        success: true,
        data: { name: "Test" },
      } as any);
      vi.mocked(projectsService.updateProject).mockRejectedValueOnce(
        new projectsService.SiteManagerInvalidError(),
      );

      const formData = new FormData();
      const res = await updateProjectAction("proj-1", undefined, formData);
      expect(res).toEqual({ status: "site-manager-invalid" });
    });

    it("handles ProjectNotFoundError database error", async () => {
      vi.mocked(projectsService.createProjectSchema.safeParse).mockReturnValueOnce({
        success: true,
        data: { name: "Test" },
      } as any);
      vi.mocked(projectsService.updateProject).mockRejectedValueOnce(
        new projectsService.ProjectNotFoundError(),
      );

      const formData = new FormData();
      const res = await updateProjectAction("proj-1", undefined, formData);
      expect(res).toEqual({ status: "not-found" });
    });

    it("handles generic database error", async () => {
      vi.mocked(projectsService.createProjectSchema.safeParse).mockReturnValueOnce({
        success: true,
        data: { name: "Test" },
      } as any);
      vi.mocked(projectsService.updateProject).mockRejectedValueOnce(new Error("DB is down"));

      const formData = new FormData();
      const res = await updateProjectAction("proj-1", undefined, formData);
      expect(res).toEqual({ status: "error", message: "Uložení změn se nezdařilo." });
    });

    it("successfully updates project", async () => {
      vi.mocked(projectsService.createProjectSchema.safeParse).mockReturnValueOnce({
        success: true,
        data: { name: "Test" },
      } as any);

      const formData = new FormData();
      await updateProjectAction("proj-1", undefined, formData);

      expect(projectsService.updateProject).toHaveBeenCalledWith(
        "proj-1",
        { name: "Test" },
        mockAuditContext,
      );
      expect(revalidatePath).toHaveBeenCalledWith("/projects");
      expect(revalidatePath).toHaveBeenCalledWith("/projects/proj-1");
      expect(redirect).toHaveBeenCalledWith("/projects/proj-1");
    });
  });

  describe("addMemberAction", () => {
    it("returns validation error for invalid input", async () => {
      const res = await addMemberAction({ projectId: "", userId: "", role: "INVALID" as any });
      expect(res?.validationErrors).toBeDefined();
    });

    it("fails if unauthorized", async () => {
      vi.mocked(rbac.requireBoss).mockRejectedValueOnce(new Error("Unauthorized"));
      const res = await addMemberAction({ projectId: "p1", userId: "u1", role: "BOSS" });
      expect(res?.serverError).toBeDefined();
    });

    it("successfully adds member and ignores errors silently", async () => {
      // Simulate silent failure as per code
      vi.mocked(projectsService.addProjectMember).mockRejectedValueOnce(new Error("DB error"));
      const res = await addMemberAction({ projectId: "p1", userId: "u1", role: "WORKER" });

      // Still returns ok: true because of the catch block
      expect(res?.data).toEqual({ ok: true });
      expect(projectsService.addProjectMember).toHaveBeenCalledWith(
        "p1",
        "u1",
        "WORKER",
        mockAuditContext,
        "user1",
      );
      expect(revalidatePath).toHaveBeenCalledWith("/projects/p1");
    });
  });

  describe("removeMemberAction", () => {
    it("successfully removes member", async () => {
      const res = await removeMemberAction({ projectId: "p1", userId: "u1" });

      expect(res?.data).toEqual({ ok: true });
      expect(projectsService.removeProjectMember).toHaveBeenCalledWith(
        "p1",
        "u1",
        mockAuditContext,
      );
      expect(revalidatePath).toHaveBeenCalledWith("/projects/p1");
    });

    it("fails if database throws", async () => {
      vi.mocked(projectsService.removeProjectMember).mockRejectedValueOnce(new Error("DB Error"));
      const res = await removeMemberAction({ projectId: "p1", userId: "u1" });
      expect(res?.serverError).toBeDefined();
    });
  });

  describe("archiveProjectAction", () => {
    it("successfully archives project and redirects", async () => {
      await archiveProjectAction({ projectId: "p1" });

      expect(projectsService.archiveProject).toHaveBeenCalledWith("p1", mockAuditContext);
      expect(revalidatePath).toHaveBeenCalledWith("/projects");
      expect(revalidatePath).toHaveBeenCalledWith("/projects/p1");
      expect(redirect).toHaveBeenCalledWith("/projects");
    });
  });

  describe("restoreProjectAction", () => {
    it("successfully restores project and redirects", async () => {
      await restoreProjectAction({ projectId: "p1" });

      expect(projectsService.restoreProject).toHaveBeenCalledWith("p1", mockAuditContext);
      expect(revalidatePath).toHaveBeenCalledWith("/projects");
      expect(revalidatePath).toHaveBeenCalledWith("/projects/p1");
      expect(redirect).toHaveBeenCalledWith("/projects/p1");
    });
  });

  describe("createHandoverAction", () => {
    it("fails with validation error if required fields are missing", async () => {
      const res = await createHandoverAction({
        projectId: "",
      } as any);
      expect(res?.validationErrors).toBeDefined();
    });

    it("successfully creates handover", async () => {
      vi.mocked(handoversService.createHandover).mockResolvedValueOnce({ id: "h1" } as any);
      const res = await createHandoverAction({
        projectId: "p1",
        type: "Typ předání",
        date: new Date("2023-01-01"),
        participants: "John, Doe",
        meterStates: null,
      });

      expect(handoversService.createHandover).toHaveBeenCalledWith("p1", "user1", {
        type: "Typ předání",
        date: new Date("2023-01-01"),
        participants: "John, Doe",
        meterStates: null,
        notes: null,
      });
      expect(revalidatePath).toHaveBeenCalledWith("/projects/p1");
      expect(res?.data).toEqual({ id: "h1" });
    });
  });

  describe("signHandoverAction", () => {
    it("successfully signs handover", async () => {
      const res = await signHandoverAction({ projectId: "p1", handoverId: "h1" });

      expect(handoversService.signHandover).toHaveBeenCalledWith("h1", "user1");
      expect(revalidatePath).toHaveBeenCalledWith("/projects/p1");
      expect(res?.data).toEqual({ ok: true });
    });
  });

  describe("deleteHandoverAction", () => {
    it("successfully deletes handover", async () => {
      const res = await deleteHandoverAction({ projectId: "p1", handoverId: "h1" });

      expect(handoversService.deleteHandover).toHaveBeenCalledWith("h1", "user1");
      expect(revalidatePath).toHaveBeenCalledWith("/projects/p1");
      expect(res?.data).toEqual({ ok: true });
    });
  });

  describe("addAuthorizedPersonAction", () => {
    it("successfully adds authorized person", async () => {
      vi.mocked(personsService.addExternalPerson).mockResolvedValueOnce({ id: "person1" } as any);
      const res = await addAuthorizedPersonAction({
        projectId: "p1",
        name: "John Doe",
        company: "Corp",
        authorization: "Auth",
      });

      expect(personsService.addExternalPerson).toHaveBeenCalledWith(
        {
          projectId: "p1",
          name: "John Doe",
          company: "Corp",
          authorization: "Auth",
        },
        mockAuditContext,
      );
      expect(revalidatePath).toHaveBeenCalledWith("/projects/p1");
      expect(res?.data).toEqual({ id: "person1" });
    });
  });

  describe("updateAuthorizedPersonAction", () => {
    it("successfully updates authorized person", async () => {
      vi.mocked(personsService.updatePerson).mockResolvedValueOnce({ id: "person1" } as any);
      const res = await updateAuthorizedPersonAction({
        projectId: "p1",
        personId: "person1",
        name: "Jane Doe",
        company: "Corp",
        authorization: "Auth",
      });

      expect(personsService.updatePerson).toHaveBeenCalledWith(
        "person1",
        {
          name: "Jane Doe",
          company: "Corp",
          authorization: "Auth",
        },
        mockAuditContext,
      );
      expect(revalidatePath).toHaveBeenCalledWith("/projects/p1");
      expect(res?.data).toEqual({ id: "person1" });
    });
  });

  describe("revokeAuthorizedPersonAction", () => {
    it("successfully revokes authorized person", async () => {
      const res = await revokeAuthorizedPersonAction({ projectId: "p1", personId: "person1" });

      expect(personsService.revokePerson).toHaveBeenCalledWith("person1", mockAuditContext);
      expect(revalidatePath).toHaveBeenCalledWith("/projects/p1");
      expect(res?.data).toEqual({ ok: true });
    });
  });
});
