/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unused-vars */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock env variables so imports don't fail
vi.mock("@/lib/env", () => ({
  env: {
    isBuildPhase: false,
    databaseUrl: "postgres://test",
    authSecret: "secret",
    dataDir: "/data",
  },
}));

import * as auditCtx from "@/server/audit-context";
import * as rbac from "@/server/rbac";
import * as reportsService from "@/server/services/reports";
import * as photosService from "@/server/services/photos";
import * as visitsService from "@/server/services/visits";
import { ForbiddenError } from "@/server/permissions";
import {
  createReportAction,
  updateReportAction,
  addRemarkAction,
  addMaterialAction,
  toggleMaterialAction,
  bulkResolveMaterialsAction,
  rolloverMaterialAction,
  setManualWeatherAction,
  deletePhotoAction,
  signReportAction,
  addAddendumAction,
  deleteVisitAction,
  acknowledgeReportAction,
  addVisitAction,
} from "./actions";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { pragueDayStart } from "@/lib/dates";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));

vi.mock("@/server/rbac", () => ({
  requireUser: vi.fn(),
  requireAdmin: vi.fn(),
  requireBoss: vi.fn(),
}));

vi.mock("@/server/audit-context", () => ({
  getAuditContext: vi.fn(),
}));

vi.mock("@/server/services/reports", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/services/reports")>();
  return {
    ...actual,
    createReport: vi.fn(),
    updateReport: vi.fn(),
    addRemark: vi.fn(),
    addMaterialNeed: vi.fn(),
    setMaterialResolved: vi.fn(),
    rolloverMaterial: vi.fn(),
    setManualWeather: vi.fn(),
    signReport: vi.fn(),
    addAddendum: vi.fn(),
    acknowledgeReport: vi.fn(),
  };
});

vi.mock("@/server/services/photos", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/services/photos")>();
  return {
    ...actual,
    softDeletePhoto: vi.fn(),
  };
});

vi.mock("@/server/services/visits", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/services/visits")>();
  return {
    ...actual,
    createVisit: vi.fn(),
    deleteVisit: vi.fn(),
  };
});

// Since Vitest mock hoist will happen before imports, the above will mock everything properly.

describe("Reports Actions", () => {
  const mockUser = {
    id: "user1",
    nickname: "tester",
    displayName: "Test User",
    role: "WORKER",
    isAdmin: false,
    mustChangePwd: false,
    sessionId: "sess1",
  };
  const mockBoss = { ...mockUser, id: "boss1", role: "BOSS" };
  const mockAudit = { actor: { id: "user1" }, ip: null, userAgent: "test" };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(rbac.requireUser).mockResolvedValue(mockUser as any);
    vi.mocked(rbac.requireBoss).mockResolvedValue(mockBoss as any);
    vi.mocked(auditCtx.getAuditContext).mockResolvedValue(mockAudit);
  });

  describe("createReportAction", () => {
    it("returns field errors on invalid input (Zod validation failure)", async () => {
      const data = new FormData();
      const res = await createReportAction("proj1", "2026-01-01", undefined, data);
      expect(res.status).toBe("field-error");
    });

    it("returns forbidden if user cannot access project (RBAC failure)", async () => {
      const data = new FormData();
      data.set("workDescription", "Nějaká práce");

      vi.mocked(reportsService.createReport).mockRejectedValueOnce(new ForbiddenError("test"));
      const res = await createReportAction("proj1", "2026-01-01", undefined, data);
      expect(res.status).toBe("forbidden");
    });

    it("returns error on simulated database failure", async () => {
      const data = new FormData();
      data.set("workDescription", "Nějaká práce");

      vi.mocked(reportsService.createReport).mockRejectedValueOnce(new Error("DB error"));
      const res = await createReportAction("proj1", "2026-01-01", undefined, data);
      expect(res.status).toBe("error");
    });

    it("returns exists if report exists", async () => {
      const data = new FormData();
      data.set("workDescription", "Nějaká práce");

      vi.mocked(reportsService.createReport).mockRejectedValueOnce(
        new reportsService.ReportExistsError(),
      );
      const res = await createReportAction("proj1", "2026-01-01", undefined, data);
      expect(res.status).toBe("exists");
    });
  });

  describe("addRemarkAction", () => {
    it("returns validation errors on invalid input", async () => {
      const res = await addRemarkAction({ reportId: "", text: "", projectId: "", date: "" });
      expect(res?.validationErrors).toBeDefined();
    });

    it("returns server error on forbidden (RBAC failure)", async () => {
      vi.mocked(reportsService.addRemark).mockRejectedValueOnce(new ForbiddenError("test"));
      const res = await addRemarkAction({
        reportId: "r1",
        text: "remark",
        projectId: "p1",
        date: "2026-01-01",
      });
      expect(res?.serverError).toBe("Nemáte oprávnění přidat připomínku.");
    });

    it("returns server error on locked report", async () => {
      vi.mocked(reportsService.addRemark).mockRejectedValueOnce(
        new reportsService.ReportLockedError(),
      );
      const res = await addRemarkAction({
        reportId: "r1",
        text: "remark",
        projectId: "p1",
        date: "2026-01-01",
      });
      expect(res?.serverError).toBe("Záznam je uzamčen.");
    });
  });

  describe("toggleMaterialAction", () => {
    it("returns ok on success", async () => {
      const res = await toggleMaterialAction({
        materialId: "m1",
        resolved: true,
        projectId: "p1",
        date: "2026-01-01",
      });
      expect(res?.data?.ok).toBe(true);
      expect(revalidatePath).toHaveBeenCalledWith("/projects/p1/reports/2026-01-01");
    });

    it("returns server error on forbidden", async () => {
      vi.mocked(reportsService.setMaterialResolved).mockRejectedValueOnce(
        new ForbiddenError("test"),
      );
      const res = await toggleMaterialAction({
        materialId: "m1",
        resolved: true,
        projectId: "p1",
        date: "2026-01-01",
      });
      expect(res?.serverError).toBe("Nemáte oprávnění měnit stav položky.");
    });
  });

  describe("rolloverMaterialAction", () => {
    it("returns server error if target date is invalid format", async () => {
      const res = await rolloverMaterialAction({
        materialId: "m1",
        targetDate: "invalid",
        projectId: "p1",
        date: "2026-01-01",
      });
      expect(res?.validationErrors?.targetDate).toBeDefined();
    });

    it("returns server error if material not found", async () => {
      vi.mocked(reportsService.rolloverMaterial).mockRejectedValueOnce(
        new reportsService.MaterialNotFoundError(),
      );
      const res = await rolloverMaterialAction({
        materialId: "m1",
        targetDate: "2026-01-02",
        projectId: "p1",
        date: "2026-01-01",
      });
      expect(res?.serverError).toBe("Materiálový požadavek nebyl nalezen.");
    });
  });

  describe("updateReportAction", () => {
    it("returns field errors on invalid input", async () => {
      const data = new FormData();
      const res = await updateReportAction("r1", "proj1", "2026-01-01", undefined, data);
      expect(res.status).toBe("field-error");
    });

    it("returns ok and redirects on success", async () => {
      const data = new FormData();
      data.set("workDescription", "Nějaká práce opravená");
      vi.mocked(reportsService.updateReport).mockResolvedValueOnce({} as any);

      await updateReportAction("r1", "proj1", "2026-01-01", undefined, data);

      expect(reportsService.updateReport).toHaveBeenCalled();
      expect(revalidatePath).toHaveBeenCalledWith("/projects/proj1");
      expect(revalidatePath).toHaveBeenCalledWith("/projects/proj1/reports/2026-01-01");
      expect(redirect).toHaveBeenCalledWith("/projects/proj1/reports/2026-01-01");
    });

    it("returns locked if report is locked", async () => {
      const data = new FormData();
      data.set("workDescription", "Nějaká práce opravená");
      vi.mocked(reportsService.updateReport).mockRejectedValueOnce(
        new reportsService.ReportLockedError(),
      );

      const res = await updateReportAction("r1", "proj1", "2026-01-01", undefined, data);
      expect(res.status).toBe("locked");
    });
  });

  describe("addAddendumAction", () => {
    it("adds addendum and revalidates", async () => {
      const res = await addAddendumAction({
        reportId: "r1",
        text: "Some addendum",
        projectId: "p1",
        date: "2026-01-01",
      });
      expect(reportsService.addAddendum).toHaveBeenCalled();
      expect(res?.data?.ok).toBe(true);
      expect(revalidatePath).toHaveBeenCalledWith("/projects/p1/reports/2026-01-01");
    });
  });

  describe("deletePhotoAction", () => {
    it("returns ok if boss deletes photo", async () => {
      const res = await deletePhotoAction({
        photoId: "photo1",
        projectId: "p1",
        date: "2026-01-01",
      });
      expect(res?.data?.ok).toBe(true);
      expect(revalidatePath).toHaveBeenCalledWith("/projects/p1/reports/2026-01-01");
    });
  });
});
